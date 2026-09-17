# MySQL persistence (internal pilot)

## Deployment

- Isolated MySQL 8.4 container `polaris-mysql`, Compose project `polaris-storage`.
- Compose files in `/opt/polaris-mysql`; named persistent volume `polaris-storage_polaris_mysql_data`.
- Published **only** at `127.0.0.1:13306`. Existing host MySQL on port 3306 is untouched.
- Random container root and application passwords live in root-only `/opt/polaris-mysql/.env`. Never commit this file, database dumps, or application `.env.local`.
- The Next.js app connects as `polaris_app`, with SELECT/INSERT/UPDATE/DELETE only on `polaris_content_studio.projects`. Schema migration runs separately as container root.
- `deploy/mysql/init.sql` runs on a fresh volume. For an existing volume, apply migrations explicitly; restarting Compose does not rerun initialization.
- Resource limits: 1 CPU, 1 GiB memory, 256 MiB InnoDB buffer pool. Docker restarts the container unless stopped.

## Saved data and workflow

Snapshots include original source, imported URL/configuration/manual overrides, source references, selected platforms, generated assets, saved edits, adopted rewrite history/conversations and approval status. No API credentials are included.

Changes are autosaved after a 1.2-second debounce, including partial generation results. Users can also save immediately, save a separate project, or restore one of the latest 100 history entries. Reload restores the last project for this browser when available. Wait for **Saved to MySQL** before refreshing/closing. Changes in an open editor only persist after its existing Save/Apply action. Running AI jobs are not durable background tasks and do not resume after reload; saved partial assets remain available.

Before replacing a source or starting a new generation run, the previous database snapshot with generated assets is archived as another history entry in the same transaction. This is not full immutable per-keystroke audit history. If an entire run starts and ends before any save succeeds, the database cannot recover unsaved work.

## Isolation and concurrency

- Projects belong to an anonymous, 256-bit, HttpOnly, SameSite=Strict browser cookie; the database stores only its SHA-256 hash.
- Every project read/write is scoped by that hash. Write requests require the same Origin. HTTPS uses Secure cookies; the LAN deployment currently uses HTTP.
- This is **not account authentication**, organization membership, or role-based access. Anyone using the same browser profile shares its projects. Clearing cookies, changing browsers, or changing hostnames loses automatic access to those projects. Authorized administrators can still inspect the database to investigate a project by its displayed ID.
- Localhost and the LAN host have different browser identities even though they connect to the same database. There is no cross-device project sharing yet.
- Optimistic version checks reject stale-tab writes with HTTP 409. Reload from history, or save the stale tab as a new project. No silent overwrite.
- Snapshot schemas and a streamed 4 MiB body cap are enforced. API failures retain in-memory work and show errors; there is no silent local-success fallback.
- No public deployment is intended. Add login, quotas/rate limits, HTTPS and account ownership before exposing this service publicly.

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

## Tests

```sh
TEST_BASE_URL=http://localhost:3002 node scripts/test-project-storage.mjs
```

This exercises a real database with mocked AI: autosave, reload restoration, source/assets/approval preservation, browser isolation, origin checks, malformed snapshot rejection, version conflicts, and generation archiving. It deletes only rows for its freshly created test-browser identities. Set local MYSQL_* variables to the same database as the target app. Normal workflow regressions should mock `/api/projects` when persistence is irrelevant, to avoid leaving test fixtures in real history.
