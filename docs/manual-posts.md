# Manual posts (Overview and Posts)

Overview and Posts let a signed-in member write a post by hand, attach up to ten images or one MP4, and hand it to
Postiz as a **draft**. Polaris never publishes and never schedules: promoting the draft stays a
human decision inside Postiz. The AI workspace, its projects and their export flow are unchanged.

## Pages

- **Overview** (`/`) is the default page. Four cards show connected accounts, local drafts, fully
  pushed posts and posts that need attention; the right column lists account health; the left
  column lists recent manual-post activity for the last 24 hours or 7 days. Every number covers
  manual posts only.
- **Posts** (`/?view=posts`) is the list: status tabs with live counts, search over the title and
  body, platform/account/edited-within filters, and paging. A row opens the editor; the row actions
  copy the post as a new draft or delete a purely local one with a visible text button.
- **Editor** (`/?view=posts&compose=new`, then `/?view=posts&postId=…`): body and an ordered media collection share a
  compact composer; **Platforms > Add platform** opens a compact account popover with platform names,
  usernames and multi-selection, without avatars or search/filter controls. There is no internal-title field, character counter, profile group,
  simulated feed, publish-now option or scheduler. The right-hand summary lists chosen accounts,
  their results and the **Push drafts** action. Existing internal titles are preserved;
  only a selected YouTube channel exposes the title as its video title and sends it to Postiz.
  The composer creates the record on the first effective edit; afterwards every
  change is autosaved with a version check, so a second tab cannot overwrite it silently.
- **Delete draft** is available in the editor after autosave starts or a local draft is loaded.
  Confirmation discards unsaved edits. Deletion waits for an existing create/update request and
  pauses further autosaves until the result is known. A failure leaves the draft editable;
  accepted, submitting and unconfirmed targets remain protected by the server's deletion guard.
- **Engine-neutral UI.** System labels and errors use draft/publishing-service terminology in all
  four languages. The internal API integration, stored IDs and console URLs are unchanged; user
  post text and account names are not rewritten.

## What the statuses mean

| Target status | Meaning | What the UI allows |
| --- | --- | --- |
| Not submitted | Selected, never handed over | Submit now |
| Submitting | A claim is in flight | Wait |
| Draft accepted | Postiz accepted the draft | Nothing; the local copy is read-only |
| Review rejected | The current draft was rejected during review | Resubmit this account for review; copy the post to edit content |
| Failed | Postiz refused the draft (or the image upload failed) | Retry this account |
| Needs review | The result could not be confirmed | Check Postiz; no automatic retry |

The post-level status is derived from these rows: `draft` (nothing sent), `pushing` (something in
flight), `pushed` (every selected account accepted) and `attention` (a failure, an unconfirmed
result, rejection, or a partial delivery). A rejected account no longer contributes to the accepted
progress count, and the list shows a rejection badge under Needs attention.

## Review synchronization and resubmission

The background worker already observes review facts in `social_post_tracking`. Manual posts now
join that record through the target's **current** `audit_id`, upstream post ID, owning user,
post ID and integration ID. An unrelated or older audit cannot change the current target.
The database target remains `accepted` to preserve the fact that its content was handed over;
`rejected` is a read-time projection. No schema migration or rejection backfill is needed.

- The deployed review contract is `DRAFT` plus `saveAction: "pass"`, not `ERROR` or the word "pass"
  alone. See `docs/feishu-notifications.md`. Missing facts do not prove rejection.
- The production worker checks approximately once a minute. Open list/editor views quietly refresh
  local status every 15 seconds and on focus/visibility changes; the editor also has Refresh status.
  These reads do not force a live upstream scan, so worker downtime or upstream errors delay updates.
- Status refresh preserves typed text, image edits, selected accounts and optimistic content version.
  Responses started before saving/deleting/submitting cannot overwrite a newer operation.
- A rejected retry uses the existing submit endpoint with `expectedVersion` and the displayed
  `expectedAuditId`. The server freezes the owned, version-checked target and enqueues its immutable
  snapshot in one transaction, then returns 202. The background worker checks current permissions,
  verifies a fresh upstream rejection without holding a transaction, and rechecks the frozen attempt.
- A successful retry creates a **new draft**, appends audit history, and replaces the current target's
  audit/upstream IDs atomically for that attempt. Old tracking observations cannot re-reject it.
- A definite retry failure restores the original rejected binding and leaves it frozen. A transport
  uncertainty becomes Needs review and cannot be blindly retried. Double clicks and stale review IDs
  do not create another draft.
- Rejection does not unlock the shared content, even when all accounts rejected it. Copy as new draft
  is the editing path, because other selected accounts may already have accepted the shared snapshot.

Old rejected drafts are retained remotely for history. Do not manually promote an older draft after
resubmitting it. Live verification and local claims cannot form an atomic transaction with the remote
engine, so a simultaneous administrator change can still race with creation of the replacement draft.

## Rules worth knowing before using it

- **Pushing is per account.** Each selected account receives its own Postiz draft of the same text
  and attachment. Accounts with a current non-rejected acceptance are never submitted again; a failed account can be
  retried on its own. The post is not blocked for everyone when one platform refuses it, and
  Instagram alone requires an image or video.
- **A successful hand-off freezes the text and attachment.** While any account is accepted, rejected, submitting
  or unconfirmed, the editor is read-only and the account selection cannot change, so every account
  received the same content. To change the wording afterwards, use *Copy as new draft* and submit
  the copy; the original draft stays in Postiz for an administrator to edit there.
- **Latest snapshot first.** Clicking push locks editing and waits for an in-flight save, then
  flushes newer changes before submitting. Account chips and the right summary reflect the local
  selection immediately, rather than waiting for the autosave response.
- **Background acceptance is not success.** After 202 the editor shows processing and can be closed.
  Reopening reads the same frozen target; queued work survives restarts. Expired running leases and
  create transport uncertainty become *Needs review*, never an automatic create retry. Open the
  publishing console, check whether the draft exists, and only then decide.
- **Deleting is local.** A post with no accepted, in-flight or unconfirmed target can be deleted;
  anything that reached Postiz must be removed there.
- **Accounts follow the existing ownership model.** Members only see and submit to their own
  accounts; administrators can use any account but cannot read another member's post. Members have
  no Postiz back office entry, so editing an accepted draft is an administrator hand-off.
- **Images.** Select or drop up to ten JPG/PNG/WebP images, append more, remove individual images,
  or move them left/right. X permits four; YouTube requires one MP4 instead. Each original may be
  up to 30 MiB; the browser prepares at most 1 MiB/2048 px before uploading it individually.
  The server decodes and validates each image, uploads it once to Postiz and records an owner-bound
  local ID. Saving and submission use ordered IDs, not repeated base64 bodies. Failed files can be
  retried independently; cancellation and late responses cannot replace another editor session.
  Legacy inline images remain readable and are imported on first append. Images and MP4 are exclusive.
- **Video references.** POST/PATCH accept `videoMediaId` as an omitted field, `null` or an uploaded
  local UUID. On PATCH, omission keeps the stored attachment; `null` removes only the video. Setting
  a video clears all image columns, and setting an image clears the video reference. Nonempty image
  data and a video in one request are rejected. Owner validation shares the version/frozen save
  transaction and is also enforced by storage helpers. Details expose `videoMediaId` (or `null`),
  and list rows expose `hasVideo`; preview uses `/api/media/uploads/:id`. Copies reuse the same
  owner's immutable upload receipt without copying targets. Removing or deleting a local draft
  does not delete shared upstream media. Upload limits and readiness are covered in `docs/video-uploads.md`.
- **Draft content is not publication.** No platform character budget is displayed or enforced by
  the composer; the bounded local storage limit remains. Postiz may refuse invalid content, and
  publication-specific validation is handled when reviewing/promoting a draft in Postiz.

## Postiz API contract

Verified against the official documentation:
[Create Post](https://docs.postiz.com/public-api/posts/create) and
[Upload File](https://docs.postiz.com/public-api/uploads/upload-file).

- The browser calls Polaris's authenticated per-account submission route. API credentials remain
  on the server; the existing account ownership and version checks apply before handing off.
- New images upload individually through authenticated `POST /api/media/images`, using bounded JSON
  `{ requestId, dataUrl, name? }`. Responses expose only `{ image: { id, name, bytes, width, height } }`.
  IDs are checked against the current owner on save, enqueue and execution; administrators cannot
  borrow another user's images. `GET /api/media/images/:id?size=thumb` serves private thumbnails;
  full previews redirect only to trusted registered media, and `?download=1` supports same-origin ZIP export.
- `createStrictDraft` reuses ordered server-resolved Postiz references in the `image` array. The old
  single-inline-image path still uploads using `POST /public/v1/upload` for historical snapshots.
  A missing or invalid image fails the complete target instead of silently dropping an attachment.
- It then calls `POST /public/v1/posts` with `type: "draft"`, a required ISO `date`,
  `shortLink: false`, `tags: []` and one entry in `posts` containing `integration: { id }`,
  `value: [{ content, image: [{ id, path }] }]` and provider-specific `settings.__type`.
  The `date` satisfies the API schema; `type: "draft"` prevents scheduling or publishing.
- YouTube channels use the same account selection, MP4 upload and queue. Selecting YouTube reveals
  the existing post title field as a video title; submission requires an owned MP4, a 2–100-character
  title without `<` or `>`, and a description of at most 5,000 UTF-8 bytes without `<` or `>`
  (empty is allowed).
  The title is frozen with the content and video reference in the queued task. Settings use
  `__type: "youtube"`, the frozen `title`, and `type: "private"`; administrators review visibility
  in Postiz before publishing. No audience declaration is inferred. The existing 100 MiB MP4
  limit still applies, and Google OAuth credentials are configured only on Postiz.
- The returned `postId` is stored per account. Non-rejected accepted accounts are not submitted again;
  transport-uncertain results require manual review rather than automatic retries.

## Operating notes

- Storage, permissions and the claim/result protocol are documented in `docs/mysql-storage.md`
  (section "Manual posts").
- Apply `deploy/mysql/migrations/2026-10-29-image-uploads.sql` before running this version on an
  existing database; the LAN deploy script replays migrations. New databases use `deploy/mysql/init.sql`.
  It adds immutable `image_uploads` (SELECT/INSERT only) and nullable `posts.image_media_ids`.
  NULL means legacy single-image storage; [] explicitly clears it. No historical images are backfilled.
  Removing a reference or deleting a post never deletes potentially shared upstream media.
  An upstream upload followed by a failed database insert can leave an orphan; cross-service atomic
  upload and automatic remote cleanup are not claimed.
- `node scripts/test-image-uploads.mjs` checks isolated uploads, replay, ownership, previews and migration parity.
- `node scripts/test-manual-posts.mjs` covers the hand-off rules without a database.
- `node scripts/test-manual-post-reviews.mjs` exercises current-audit rejection projection and retry
  safety using actual SQL expressions through an in-memory SQLite adapter. It does not validate
  MySQL-specific row locks; use Node 22 with `node:sqlite` available.
- `node scripts/test-post-composer.mjs` runs the real editor and image preparation in Chrome with
  mocked Polaris API responses: account selection, autosave/push races, read-only snapshots and
  responsive layouts. It does not create drafts in a live Postiz instance.
- Shared queue migration, worker switches, state machine and asynchronous acceptance tests:
  `docs/async-draft-submissions.md` and `deploy/mysql/migrations/2026-10-19-draft-submissions.sql`.
