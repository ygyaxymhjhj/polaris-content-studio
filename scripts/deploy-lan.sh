#!/usr/bin/env bash
# One-command deploy of committed code to the LAN test server.
# Server layout and troubleshooting: docs/lan-deployment.md
#
# Usage:
#   scripts/deploy-lan.sh                # deploy current HEAD commit
#   scripts/deploy-lan.sh --ref <sha>    # deploy a specific commit (also for rollback)
#   scripts/deploy-lan.sh --worktree     # deploy the working tree as-is (includes uncommitted changes)
#   scripts/deploy-lan.sh --no-db        # skip the database backup and migration steps
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
WITH_DB=1
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --worktree) USE_WORKTREE=1; shift ;;
    --no-build) echo "error: --no-build is unsafe; deployments must rebuild production artifacts before starting the service." >&2; exit 2 ;;
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

echo "==> 1/7 stop service"
ssh "$SERVER" "systemctl stop $SERVICE"

echo "==> 2/7 backup"
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

echo "==> 3/7 sync code"
rsync "${RSYNC_FLAGS[@]}" "$SRC/" "$SERVER:$APP_DIR/"

echo "==> 4/7 install runtime integration files"
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

echo "==> 5/7 build (npm ci + next build)"
ssh "$SERVER" bash -s -- "$APP_DIR" "$RUN_USER" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; RUN_USER=$2
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
runuser -u "$RUN_USER" -- bash -c "cd '$APP_DIR' && export PATH=/usr/local/bin:\$PATH && npm ci && NEXT_TELEMETRY_DISABLED=1 npm run build"
REMOTE

echo "==> 6/7 apply database migrations"
ssh "$SERVER" bash -s -- "$APP_DIR" "$WITH_DB" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; WITH_DB=$2
if [ "$WITH_DB" != 1 ]; then
  echo "note: --no-db given; skipping database migrations (apply deploy/mysql/migrations/*.sql manually)"
  exit 0
fi
if ! command -v docker >/dev/null 2>&1 || ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'polaris-mysql'; then
  echo "error: polaris-mysql container not found; cannot apply database migrations before starting the service" >&2
  exit 1
fi
# Every file in deploy/mysql/migrations is idempotent by convention (CREATE TABLE IF NOT EXISTS /
# conditional ALTER / GRANT), so applying them on each deploy keeps the schema in step with the
# code that is about to start. A failure aborts the deploy before the service is restarted.
# The base schema goes first: init.sql is idempotent (CREATE TABLE IF NOT EXISTS + GRANT), so it
# creates any tables a pre-existing volume is missing before the delta migrations reference them.
echo "applying base schema (deploy/mysql/init.sql)"
docker exec -i polaris-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' < "$APP_DIR/deploy/mysql/init.sql"
for file in "$APP_DIR"/deploy/mysql/migrations/*.sql; do
  echo "applying $(basename "$file")"
  docker exec -i polaris-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' < "$file"
done
echo "database migrations applied"
REMOTE

echo "==> 7/7 record commit, start, verify"
ssh "$SERVER" bash -s -- "$APP_DIR" "$RUN_USER" "$SERVICE" "$HEALTH_URL" "$COMMIT" <<'REMOTE'
set -euo pipefail
APP_DIR=$1; RUN_USER=$2; SERVICE=$3; HEALTH=$4; COMMIT=$5
# Anonymous /login does not query users, so HTTP 200 alone cannot verify a role migration.
runuser -u "$RUN_USER" -- bash -c "cd '$APP_DIR' && export PATH=/usr/local/bin:\$PATH && node scripts/check-user-roles.mjs"
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
