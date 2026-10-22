# Durable draft submissions

AI content cards and manual posts now acknowledge a committed local job with **HTTP 202**. This
means accepted for background processing, not accepted by the publishing engine, and never means
published. Neither request waits for account-network checks, image upload, draft creation or group
notification delivery. The legacy synchronous manual function remains covered for reuse, but the
HTTP entry points use the durable queue.

## Install before starting new application code

Apply `deploy/mysql/migrations/2026-10-19-draft-submissions.sql` as the schema administrator after
the existing manual-post and notification migrations. It is idempotent and grants the app only
SELECT/INSERT/UPDATE on `draft_submissions`. Fresh volumes receive the identical table and grants
from `deploy/mysql/init.sql`. The LAN deployment script already replays every migration after
initialization revokes old grants. Do not use `--no-db` unless this migration was applied manually.
Missing schema/permissions returns 503; manual freezing and queue insertion share a transaction,
so a failed insert rolls back the freeze.

No Redis, new dependency, daemon or application DDL permission is required. The self-hosted Node
process starts a separate five-second draft scheduler through `src/instrumentation.ts` in production.
Development and tests do not consume stored work automatically; explicitly set
`DRAFT_SUBMISSIONS_SCHEDULER_ENABLED=true` to opt in. `SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED=false`
does not stop drafts.
`DRAFT_SUBMISSIONS_SCHEDULER_ENABLED=false` disables periodic recovery only; request `after()`
callbacks still drain committed work, with overlapping wakeups sharing the same completion promise.
Keep the scheduler enabled in normal self-hosted use for restart recovery.
Vercel/serverless periodic scheduling is not supported; `after()` alone is not a durable runner.

## State machine and recovery

- `queued` is committed, safe to claim after any restart, and has not begun external execution.
- An atomic `FOR UPDATE SKIP LOCKED` claim changes it to `running`, with a random lease token and
  five-minute deadline. No transaction or row lock is held across network calls.
- `running` becomes `succeeded` on confirmed creation, `failed` on a definite refusal or validation
  failure, or `unknown` on a create transport uncertainty.
- An expired `running` job becomes `unknown`, never `queued`. It is not automatically recreated,
  even if a crash happened before the create call. The owner must have an operator check the engine.
- A late confirmed answer can replace `unknown` only for the same lease token. A manual result is
  additionally bound to the exact target attempt; older attempts cannot replace a newer target.
- Target completion and job completion commit together. A created draft remains `succeeded` with
  a warning if local audit/outbox registration fails. Such warnings never invite resubmission.
- The old 120-second manual sweep excludes queue-owned queued/running attempts. Queue waiting is
  not treated as an unconfirmed external result.

Workers re-read the user's current enabled flag and role, channel ownership, source-project
ownership and live channel availability. An admin flag captured at request time is not authority
to execute later. A rejected retry also needs a fresh `DRAFT` + `saveAction=pass` observation, the
original owner/audit/upstream binding, and the current frozen manual attempt. A definite failure
restores the original frozen binding; an uncertain create remains needs-review.

## Snapshots and deduplication

The queue stores immutable text, image data URL/reference, account metadata and original review
binding; manual jobs also store the frozen post version and attempt. Editing another asset,
switching projects or closing the browser never changes queued payloads. Uploaded images are
inline snapshots. A remote image is a frozen URL reference, not a copy of remote bytes: the remote
host must retain that image until the worker fetches it; upload failure aborts rather than sending
text-only content.

Single MP4 attachments use an owner-bound `videoMediaId` instead of image bytes or an upstream path.
Manual claims read that ID under the post's version/frozen transaction; AI enqueue checks the ID's
owner in its enqueue transaction. Project saves bulk-check asset video IDs in their save transaction,
including for administrators; image-only snapshots do not query the video table. An asset's video
suppresses any article-cover fallback at the caller, and a nonempty image plus video is rejected.
The worker resolves the immutable ready receipt again for the task owner and supplies its registered
`{ id, path }` as `uploadedMedia` to `createStrictDraft`, without downloading or uploading the video.
Queued snapshots contain only the local video ID, never MP4/base64, temporary files or client paths.
Video fingerprints include that ID; legacy text/image fingerprints retain their previous structure.
Removing an attachment only unbinds it; shared upload receipts are not automatically deleted.

AI callers supply a UUID `requestId`. Owner-scoped request keys deduplicate replay of that exact
request; an active owner/project/asset/account key blocks different concurrent payloads and all
unknown results. A successful snapshot fingerprint deduplicates lost-response retries even with a
new request ID. Edited snapshots are different, and an intentional rejected retry includes the
current `expectedAuditId`, so successful deduplication does not permanently prevent resubmission.
Definite failures release the active key and can be intentionally retried using a new request ID.
Manual claims serialize through the owned post and use the target attempt as their durable identity.

## Readback and UI

`GET /api/social/draft-submissions?ids=...` returns exact jobs. For card recovery use
`sourceIds=...&projectId=...`; this returns the latest job per source/account. Queries are limited
to 64 identifiers and always restricted to the current owner, including administrators. Responses
contain task state, source/account identifiers, upstream/audit IDs, safe warnings/errors and UTC
timestamps, never text, images, permissions or lease tokens.

Cards poll local task state independently of the existing audit/review polling. Task binding is
persisted in project snapshots, and source lookup recovers jobs when the response or its autosave
was lost. Cards show processing/needs-review without fabricating drafted/published status. Batch
acceptance uses two concurrent local requests; another card does not share a global submit lock.
Manual navigation is locked only while the latest save and acceptance requests are pending;
after 202 users can leave and reopen the frozen post while the worker continues.

Notifications are still produced through `recordSocialSubmission` and the existing notification
outbox. Draft workers never call the delivery function or wait for Feishu network responses.

## Verification and limits

`node scripts/test-async-submissions.mjs` uses transpiled real routes/storage/worker code with an
isolated SQLite SQL adapter and synthetic Postiz promises. Initial RED evidence was two route
assertions receiving 200 rather than 202; the final suite covers committed acceptance before a
held create promise, rollback, snapshots, concurrent claims, deduplication, all result classes,
permission changes, owner-only reads, stale/restart recovery and rejected/late-attempt safety.
Existing manual-post, manual-review, submission-status and real-browser composer suites also run
without calling real external services. The adapter does not validate MySQL-specific locking or
production deployment; no live database migration or upstream smoke test is performed here.

For the local video-reference regressions, run
`node --test --test-name-pattern=video scripts/test-async-submissions.mjs scripts/test-feishu-submission.mjs`.
They use the same isolated SQL adapter plus mocked fetch, including a real `createStrictDraft`
payload assertion that forbids media downloads/uploads. No live Postiz compatibility is implied.

Exactly-once creation across an unavailable external API is impossible without upstream idempotency.
This implementation deliberately prefers needs-review over automatic replay whenever creation may
have occurred. There is no automated cleanup or operator-resolution endpoint for unknown jobs in
this change; retain rows until an operator has reconciled them with the publishing engine.
