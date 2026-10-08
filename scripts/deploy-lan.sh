#!/usr/bin/env bash
# One-command deploy of committed code to the LAN test server.
# Server layout and troubleshooting: docs/lan-deployment.md
#
# Usage:
#   scripts/deploy-lan.sh                # deploy current HEAD commit
#   scripts/deploy-lan.sh --ref <sha>    # deploy a specific commit (also for rollback)
#   scripts/deploy-lan.sh --worktree     # deploy the working tree as-is (includes uncommitted changes)
#   scripts/deploy-lan.sh --no-build     # sync + install files only, skip npm ci / next build
#   scripts/deploy-lan.sh --no-db        # skip the database backup step
#   scripts/deploy-lan.sh --dry-run      # show what rsync would change, touch nothing
set -euo pipefail

SERVER="${POLARIS_SERVER:-polaris-server}"
REMOTE_ROOT=/opt/polaris-content-studio
APP_DIR="$REMOTE_ROOT/app"
SERVICE=polaris-studio
RUN_USER=polaris-studio
# /login, not /: the root route redirects anonymous callers, so it answers 307 rather than 200.
HEALTH_URL=http://192.168.220.109:13300/login

REF=HEAD
USE_WORKTREE=0
DO_BUILD=1
WITH_DB=1
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --worktree) USE_WORKTREE=1; shift ;;
    --no-build) DO_BUILD=0; shift ;;
    --no-db) WITH_DB=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: run this script from inside the repository" >&2
  exit 2
fi

COMMIT=$(git rev-parse --verify "$REF^{commit}")
SHORT=$(printf '%s' "$COMMIT" | cut -c1-7)

if [ "$USE_WORKTREE" = 1 ]; then
  SRC=.
  echo "!! --worktree: deploying uncommitted working tree contents"
else
  if [ -n "$(git status --porcelain)" ]; then
    echo "note: working tree has uncommitted changes; they will NOT be deployed (use --worktree to include them):"
    git status --short | sed 's/^/  /' | head -15
  fi
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  git archive "$COMMIT" | tar -x -C "$TMP"
  SRC="$TMP"
fi

echo "==> deploy $SHORT -> $SERVER:$APP_DIR"

RSYNC_FLAGS=(-rlptz -c --delete
  --exclude '.git' --exclude '.env' --exclude '.env.local'
  --exclude 'node_modules' --exclude '.next' --exclude '.next-dev' --exclude '.DS_Store'
  --exclude 'DEPLOYED_COMMIT' --exclude '.cursor' --exclude '.playwright-mcp'
  --exclude '*.tsbuildinfo')

if [ "$DRY_RUN" = 1 ]; then
  echo "==> dry-run: rsync preview only"
  rsync "${RSYNC_FLAGS[@]}" -n -v "$SRC/" "$SERVER:$APP_DIR/"
  echo "==> dry-run done (nothing changed)"
  exit 0
fi

echo "==> 1/6 stop service"
ssh "$SERVER" "systemctl stop $SERVICE"

echo "==> 2/6 backup"
ssh "$SERVER" bash -s -- "$SHORT" "$APP_DIR" "$REMOTE_ROOT" "$WITH_DB" <<'REMOTE'
set -euo pipefail
SHORT=$1; APP_DIR=$2; ROOT=$3; WITH_DB=$4
STAMP=$(date +%Y%m%d-%H%M%S)
BK="$ROOT/backup-$STAMP-$SHORT"
mkdir -p "$BK"
chmod 700 "$BK"
cp -a "$APP_DIR/.env.local" "$BK/env-before" 2>/dev/null || true
cp -a "$ROOT/runtime" "$BK/runtime" 2>/dev/null || true
cp -a /etc/systemd/system/polaris-studio.service "$BK/" 2>/dev/null || true
cp -a /etc/systemd/system/polaris-studio.service.d "$BK/" 2>/dev/null || true
tar -C "$APP_DIR" --exclude=node_modules --exclude=.next --exclude=.next-dev --exclude=.env.local -czf "$BK/app-source.tgz" .
if [ "$WITH_DB" = 1 ]; then
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'polaris-mysql'; then
    bash "$APP_DIR/deploy/mysql/backup.sh" || echo "warn: database backup failed (continuing)"
  else
    echo "note: polaris-mysql container not found; database backup skipped"
  fi
fi
echo "backup: $BK"
REMOTE

echo "==> 3/6 sync code"
rsync "${RSYNC_FLAGS[@]}" "$SRC/" "$SERVER:$APP_DIR/"

echo "==> 4/6 install runtime integration files"
ssh "$SERVER" bash -s -- "$APP_DIR" "$REMOTE_ROOT" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; ROOT=$2
install -d -m 755 "$ROOT/runtime"
install -m 644 "$APP_DIR/deploy/runtime/openrouter-proxy.cjs" "$ROOT/runtime/openrouter-proxy.cjs"
install -d -m 755 /etc/systemd/system/polaris-studio.service.d
install -m 644 "$APP_DIR/deploy/40-openrouter-proxy.conf" /etc/systemd/system/polaris-studio.service.d/40-openrouter-proxy.conf
systemctl daemon-reload
echo "runtime files installed"
REMOTE

if [ "$DO_BUILD" = 1 ]; then
  echo "==> 5/6 build (npm ci + next build)"
  ssh "$SERVER" bash -s -- "$APP_DIR" "$RUN_USER" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; RUN_USER=$2
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
runuser -u "$RUN_USER" -- bash -c "cd '$APP_DIR' && export PATH=/usr/local/bin:\$PATH && npm ci && NEXT_TELEMETRY_DISABLED=1 npm run build"
REMOTE
else
  echo "==> 5/6 build skipped (--no-build)"
fi

echo "==> 6/6 record commit, start, verify"
ssh "$SERVER" bash -s -- "$APP_DIR" "$RUN_USER" "$SERVICE" "$HEALTH_URL" "$COMMIT" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; RUN_USER=$2; SERVICE=$3; HEALTH=$4; COMMIT=$5
printf '%s\n' "$COMMIT" > "$APP_DIR/DEPLOYED_COMMIT"
chown "$RUN_USER:$RUN_USER" "$APP_DIR/DEPLOYED_COMMIT"
systemctl start "$SERVICE"
systemctl is-active "$SERVICE"
for i in {1..10}; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH" || true)
  if [ "$CODE" = "200" ]; then echo "health: 200"; exit 0; fi
  sleep 2
done
echo "health: $CODE"
exit 1
REMOTE

echo "==> done: $SHORT deployed to $SERVER"
