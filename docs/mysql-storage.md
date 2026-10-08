# MySQL persistence (internal pilot)

## Deployment

- Isolated MySQL 8.4 container `polaris-mysql`, Compose project `polaris-storage`.
- Compose files in `/opt/polaris-mysql`; named persistent volume `polaris-storage_polaris_mysql_data`.
- Published **only** at `127.0.0.1:13306`. Existing host MySQL on port 3306 is untouched.
- Random container root and application passwords live in root-only `/opt/polaris-mysql/.env`. Never commit this file, database dumps, or application `.env.local`.
- The Next.js app connects as `polaris_app`, with SELECT/INSERT/UPDATE/DELETE only on `polaris_content_studio.projects`, `users` and `sessions`. It has no DDL rights. Schema migration runs separately as container root.
- `deploy/mysql/init.sql` runs on a fresh volume. For an existing volume, apply migrations explicitly; restarting Compose does not rerun initialization.
- Resource limits: 1 CPU, 1 GiB memory, 256 MiB InnoDB buffer pool. Docker restarts the container unless stopped.

## Saved data and workflow

Snapshots include original source, imported URL/configuration/manual overrides, source references, selected platforms, generated assets, saved edits, adopted rewrite history/conversations and approval status. No API credentials are included.

Changes are autosaved after a 1.2-second debounce, including partial generation results. Users can also save immediately, save a separate project, or restore one of the latest 100 history entries. Reload restores the last project for this browser when available. Wait for **Saved to MySQL** before refreshing/closing. Changes in an open editor only persist after its existing Save/Apply action. Running AI jobs are not durable background tasks and do not resume after reload; saved partial assets remain available.

Before replacing a source or starting a new generation run, the previous database snapshot with generated assets is archived as another history entry in the same transaction. This is not full immutable per-keystroke audit history. If an entire run starts and ends before any save succeeds, the database cannot recover unsaved work.

## Accounts and isolation

- Everyone signs in with an account from the `users` table: username, display name, a scrypt password hash and a disabled flag. Hashes are produced by Node's built-in scrypt, and the parameters travel inside each stored hash so they can be raised later without a migration.
- Signing in writes a row to `sessions` holding the **SHA-256 of the session token**, never the token itself, so a database dump does not hand over live sessions. The browser keeps an HttpOnly, SameSite=Lax `polaris-session` cookie; `Secure` is set only over HTTPS. The LAN deployment serves plain HTTP, so the cookie is not marked Secure there.
- Every project read/write is scoped by `owner_hash = sha256("polaris-user:" + user id)`, so saved work follows the person instead of the browser. Write requests still require the same Origin.
- Disabling an account, and changing its password, both delete its session rows, so the next request fails with 401. Signing out deletes the session row server-side, not merely the cookie.
- There are no roles. Any signed-in member can add members, reset passwords and disable accounts from the Settings page. An account cannot disable itself.
- Projects saved under the old anonymous browser cookie are adopted into the account on its **first** sign-in, and only when that account owns nothing yet. That covers the browser you sign in from; work saved in other browsers keeps its old `owner_hash` and an administrator can reassign it by hand.
- Localhost and the LAN host are now the same identity once you sign in on both, because the account — not the browser — owns the projects.
- Optimistic version checks reject stale-tab writes with HTTP 409. Reload from history, or save the stale tab as a new project. No silent overwrite.
- Snapshot schemas and a streamed 4 MiB body cap are enforced. API failures retain in-memory work and show errors; there is no silent local-success fallback.
- **Still not safe for the public internet.** The LAN deployment serves plain HTTP, so passwords cross the local network unencrypted, and nothing limits how much of the shared AI quota a signed-in member can spend. Add TLS and per-account quotas before exposing this outside the internal network.

## Local development

Keep MySQL private. Open an authenticated SSH tunnel (do not store passwords in scripts):

```sh
ssh -N -L 127.0.0.1:13307:127.0.0.1:13306 root@192.168.220.109
```

Set server-only local environment values: MYSQL_HOST=127.0.0.1, MYSQL_PORT=13307, MYSQL_DATABASE=polaris_content_studio, MYSQL_USER=polaris_app, and the dedicated MYSQL_PASSWORD. On the server use port 13306. A closed tunnel disconnects local persistence; the UI warns. Reopen the tunnel and retry. This tunnel is not installed as an automatic boot service.

## Backup and recovery

`deploy/mysql/backup.sh` dumps only this database, compresses it into root-only `/opt/polaris-mysql/backups`, and retains about 14 days. The deployment schedules it daily at 03:20 server time via `/etc/cron.d/polaris-mysql-backup`. Copies on the same disk protect against accidental edits, **not disk failure**; add encrypted off-host backups before production.

Restore only after stopping application writes and taking a fresh backup:

```sh
# Choose the intended private backup and confirm the overwrite with the operator first.
gzip -dc /opt/polaris-mysql/backups/CHOSEN.sql.gz | docker exec -i polaris-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot'
```

Restore is destructive to this app's database and is not part of normal deployment. Do not use `docker compose down -v`; it deletes the volume. Rolling back app files does not roll back database content.

## Publish audit (social_publishes)

- One row per publish attempt (success and failure): publisher, account snapshot, platform, content preview, Postiz post id, published URL, schedule time, status, error.
- Append-only from the app: `polaris_app` has SELECT, INSERT only on this table. A failed audit write is logged to the server console and never changes the publish result.
- Existing volumes: run `deploy/mysql/migrations/2026-10-08-social-publishes.sql` manually as admin (docker exec command in the file header; idempotent). Fresh volumes get the table from `init.sql`.
- Query API: `GET /api/social/publishes?assetId=…` or `projectId=…` (limit 50), visible to every signed-in member. Model and rationale: `docs/social-account-model.md`.

## Tests

```sh
TEST_BASE_URL=http://localhost:3002 node scripts/test-auth.mjs
TEST_BASE_URL=http://localhost:3002 node scripts/test-project-storage.mjs
```

`test-auth.mjs` covers the sign-in system: anonymous visits land on `/login`, all nine API routes answer 401 without a session, a wrong password is refused, pre-account projects are adopted exactly once, disabling an account ends its live sessions, an account cannot disable itself, signing out invalidates the token server-side, repeated failures are throttled, and the Settings page can create and disable a member.

`test-project-storage.mjs` exercises a real database with mocked AI: autosave, reload restoration, source/assets/approval preservation, account isolation, origin checks, malformed snapshot rejection, version conflicts, and generation archiving.

Both delete only the rows they create. Every browser test signs in first, so all of them need a reachable MySQL and the `MYSQL_*` variables in `.env.local`; `scripts/_login.mjs` creates a throwaway account per run and removes it, along with its projects, afterwards. Normal workflow regressions should mock `/api/projects` when persistence is irrelevant, to avoid leaving test fixtures in real history.

Note: `scripts/test-fact-review.mjs`, `test-ui-languages.mjs`, `test-source-handoff.mjs` and `test-source-config.mjs` still address UI that has since been restructured (the source panel now splits URL and paste into tabs, and generation moved behind confirmed facts), so they fail on stale selectors. They sign in correctly; repairing them is a separate task.
