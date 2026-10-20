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

Snapshots include original source, imported URL/configuration/manual overrides, source references, selected platforms, generated assets, saved edits, adopted rewrite history/conversations. No API credentials are included.

Changes are autosaved after a 1.2-second debounce, including partial generation results. Users can also save immediately, save a separate project, or restore one of the latest 100 history entries. Reload restores the last project for this browser when available. Wait for **Saved to MySQL** before refreshing/closing. Changes in an open editor only persist after its existing Save/Apply action. Running AI jobs are not durable background tasks and do not resume after reload; saved partial assets remain available.

Before replacing a source or starting a new generation run, the previous database snapshot with generated assets is archived as another history entry in the same transaction. This is not full immutable per-keystroke audit history. If an entire run starts and ends before any save succeeds, the database cannot recover unsaved work.

## Accounts and isolation

- Everyone signs in with an account from the `users` table: username, display name, a scrypt password hash and a disabled flag. Hashes are produced by Node's built-in scrypt, and the parameters travel inside each stored hash so they can be raised later without a migration.
- Signing in writes a row to `sessions` holding the **SHA-256 of the session token**, never the token itself, so a database dump does not hand over live sessions. The browser keeps an HttpOnly, SameSite=Lax `polaris-session` cookie; `Secure` is set only over HTTPS. The LAN deployment serves plain HTTP, so the cookie is not marked Secure there.
- Every project read/write is scoped by `owner_hash = sha256("polaris-user:" + user id)`, so saved work follows the person instead of the browser. Write requests still require the same Origin.
- Disabling an account, and changing its password, both delete its session rows, so the next request fails with 401. Signing out deletes the session row server-side, not merely the cookie.
- Accounts have an `admin` or `member` role. Only administrators can list, create, reset passwords for, or enable/disable members. Members retain the other workspace and social-account settings, but receive HTTP 403 from every member-management API method. An administrator cannot disable itself. New accounts default to `member`; the web API cannot assign roles.
- Existing databases must apply `deploy/mysql/migrations/2026-10-08-user-roles.sql` as a schema administrator before starting this version. It adds the role column and promotes the operator-designated existing `admin` account without changing IDs, passwords, sessions or project ownership. Fresh installations use `node scripts/create-user.mjs --admin admin` to bootstrap an administrator; omitting `--admin` creates a member.
- `node scripts/check-user-roles.mjs` verifies the column and the enabled `admin` account using application database permissions. Deployment requires a fresh production build and runs this check before starting the service; `--no-build` is rejected before any service or sync operation. Anonymous `/login` returning 200 is not a schema/role check. Do not roll back to a version that allows ordinary members to manage accounts.
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

## Manual posts (posts / post_targets)

Manual posts are written by hand in Overview → Posts and never join an AI project snapshot, so they get their own two tables. `posts` holds the owner, an internal title, the body, one validated image (data URL plus a list thumbnail), and a version. `post_targets` holds one row per selected account with its platform/name snapshot, status, Postiz draft id and audit id.

`polaris_app` has SELECT/INSERT/UPDATE/DELETE on both tables. Posts are private to their owner: every query is scoped by `owner_user_id`, and an administrator does not bypass that. Deleting a post needs no extra cleanup because `post_targets` follows through the foreign key.

- Target statuses: `not_started`, `submitting`, `accepted`, `failed`, `pending_unknown`. A post's list status is derived from these (`draft`, `pushing`, `pushed`, `attention`); there is no single `published` flag that could claim more than Postiz confirmed.
- The post stays editable and deletable only while no target is accepted, submitting or unconfirmed. A failed target can be retried with the same frozen content; changing the text after any account accepted the draft requires "Copy as new draft".
- A submission is claimed and inserted into `draft_submissions` in the same short transaction. HTTP 202 only acknowledges that commit. Background Postiz calls hold no database lock, and results are bound to the exact target attempt. Repeating a request for an accepted target returns the stored result rather than creating a second draft.
- Queue-owned queued/running claims are excluded from the legacy two-minute stale sweep. Queued work resumes after restart; an expired running lease or create transport uncertainty becomes `pending_unknown` and is never automatically recreated.
- Images are re-validated server-side with sharp (single-frame JPEG/PNG/WebP, ≤1.5 MiB, ≤2048 px on the longest edge, pixel-count guarded, remote URLs refused) and served only through `GET /api/posts/{id}/image` after an ownership check. A failed image upload aborts the hand-off instead of sending a text-only draft.
- Schema: `deploy/mysql/init.sql` plus `deploy/mysql/migrations/2026-10-15-manual-posts.sql` (idempotent, includes the grants). Workflow and page behaviour: `docs/manual-posts.md`.

## Tests

AI cards and manual posts share the durable queue described in `docs/async-draft-submissions.md`.
Apply `deploy/mysql/migrations/2026-10-19-draft-submissions.sql` for existing volumes; it includes
the same queue grants as fresh-volume initialization. `node scripts/test-async-submissions.mjs`
exercises real SQL through an isolated adapter, with no real upstream or database credentials.

```sh
TEST_BASE_URL=http://localhost:3002 node scripts/test-auth.mjs
TEST_BASE_URL=http://localhost:3002 node scripts/test-project-storage.mjs
TEST_BASE_URL=http://localhost:3002 node scripts/test-publish-dialog.mjs
```

`test-auth.mjs` covers anonymous access, sign-in, one-time legacy project adoption, logout and throttling. Its administrator fixture exercises member creation, password reset, disable and enable; its ordinary-member fixture receives 403 for GET/POST/PATCH without changing the target account or its sessions. Member settings still expose social-account connections but never mount or fetch the member panel. Administrator self-disable returns 400; an ordinary member is refused with 403 before that check. `node scripts/test-user-roles.mjs` also checks API authorization and default-member creation without a database.

`test-project-storage.mjs` exercises a real database with mocked AI: autosave, reload restoration, source/assets preservation, account isolation, origin checks, malformed snapshot rejection, version conflicts, and generation archiving.

`test-publish-dialog.mjs` drives the draft dialog with mocked channels, and asserts that selecting an account only selects it: it must not open the connect dialog, while the Manage accounts button still must.

`node scripts/test-manual-posts.mjs` needs no database or network: it exercises the strict draft client, the submission orchestration against a synthetic row, image validation with the real decoder, and the create-post validation, including the "never submit twice" and "unknown result is not retried" rules.

`node scripts/test-theme.mjs` also needs no database: it covers the automatic light/dark window, the pre-paint theme script, invalid stored values and the switch itself. With `TEST_BASE_URL` pointing at a running server it adds the browser checks. Rules and behaviour: `docs/appearance-theme.md`.

These scripts delete only the rows they create. Every browser test signs in first, so all of them need a reachable MySQL and the `MYSQL_*` variables in `.env.local`; `scripts/_login.mjs` creates a throwaway account per run and removes it, along with its projects, afterwards. Normal workflow regressions should mock `/api/projects` when persistence is irrelevant, to avoid leaving test fixtures in real history.

The app now opens on Overview, so the AI-workspace browser scripts call `openWorkspace(page)` from `scripts/_login.mjs` right after signing in. `scripts/test-project-storage.mjs` locates the references view by name instead of the old sidebar index.

Note: `scripts/test-fact-review.mjs`, `test-ui-languages.mjs`, `test-source-handoff.mjs` and `test-source-config.mjs` still address UI that has since been restructured (the source panel now splits URL and paste into tabs, and generation moved behind confirmed facts), so they fail on stale selectors. They sign in correctly; repairing them is a separate task.
