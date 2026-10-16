# Manual posts (Overview and Posts)

Overview and Posts let a signed-in member write a post by hand, attach one image, and hand it to
Postiz as a **draft**. Polaris never publishes and never schedules: promoting the draft stays a
human decision inside Postiz. The AI workspace, its projects and their export flow are unchanged.

## Pages

- **Overview** (`/`) is the default page. Four cards show connected accounts, local drafts, fully
  pushed posts and posts that need attention; the right column lists account health; the left
  column lists recent manual-post activity for the last 24 hours or 7 days. Every number covers
  manual posts only.
- **Posts** (`/?view=posts`) is the list: status tabs with live counts, search over the title and
  body, platform/account/edited-within filters, and paging. A row opens the editor; the row actions
  copy the post as a new draft or delete a purely local one.
- **Editor** (`/?view=posts&compose=new`, then `/?view=posts&postId=…`): internal title, body, one
  image, account selection grouped by platform, a simulated platform preview, and the per-account
  hand-off panel. The composer creates the record on the first effective edit; afterwards every
  change is autosaved with a version check, so a second tab cannot overwrite it silently.

## What the statuses mean

| Target status | Meaning | What the UI allows |
| --- | --- | --- |
| Not submitted | Selected, never handed over | Submit now |
| Submitting | A claim is in flight | Wait |
| Draft accepted | Postiz accepted the draft | Nothing; the local copy is read-only |
| Failed | Postiz refused the draft (or the image upload failed) | Retry this account |
| Needs review | The result could not be confirmed | Check Postiz; no automatic retry |

The post-level status is derived from these rows: `draft` (nothing sent), `pushing` (something in
flight), `pushed` (every selected account accepted) and `attention` (a failure, an unconfirmed
result, or a partial delivery).

## Rules worth knowing before using it

- **Pushing is per account.** Each selected account receives its own Postiz draft of the same text
  and image. Accounts that already accepted are never submitted again; a failed account can be
  retried on its own. The post is not blocked for everyone when one platform refuses it, and
  Instagram alone requires an image.
- **A successful hand-off freezes the text and image.** While any account is accepted, submitting
  or unconfirmed, the editor is read-only and the account selection cannot change, so every account
  received the same content. To change the wording afterwards, use *Copy as new draft* and submit
  the copy; the original draft stays in Postiz for an administrator to edit there.
- **Nothing is resubmitted automatically.** A transport failure or a claim older than two minutes
  becomes *Needs review*. Open Postiz, check whether the draft exists, and only then decide.
- **Deleting is local.** A post with no accepted, in-flight or unconfirmed target can be deleted;
  anything that reached Postiz must be removed there.
- **Accounts follow the existing ownership model.** Members only see and submit to their own
  accounts; administrators can use any account but cannot read another member's post. Members have
  no Postiz back office entry, so editing an accepted draft is an administrator hand-off.
- **Images.** One JPG/PNG/WebP up to 5 MB from the browser (compressed to about 1 MB), re-validated
  and thumbnailed on the server. Remote image URLs are not accepted for manual posts.

## Operating notes

- Storage, permissions and the claim/result protocol are documented in `docs/mysql-storage.md`
  (section "Manual posts").
- Schema changes ship in `deploy/mysql/init.sql` and
  `deploy/mysql/migrations/2026-10-15-manual-posts.sql`; the LAN deploy script replays both.
- `node scripts/test-manual-posts.mjs` covers the hand-off rules without a database.
