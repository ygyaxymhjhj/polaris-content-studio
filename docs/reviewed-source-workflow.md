# Reviewed-source workflow

The editorial team supplies articles that have already been checked. The default flow is:

1. Import the reviewed article (DOCX, paste, crawler JSON, public URL, or the browser extension).
2. Choose platforms and output language; click **Generate social drafts**.
3. The app extracts source references in the background and generates drafts directly, without a mandatory fact-confirmation screen.
4. Review generated copy for faithfulness, attribution, numbers, uncertainty, and platform fit. Approve assets before ZIP export. Nothing is published automatically.

## Evidence and review semantics

- Analysis is split into bounded chunks to reduce truncated model JSON. API and client normalize the result before rendering.
- Only excerpts matching the supplied article (with whitespace normalized) are automatically enabled. This does not prove that the extracted claim accurately interprets the quote; final copy still needs editorial review.
- `sourceReviewBasis: "team-reviewed-article"` records why references were enabled. Legacy `fact.verified` is used as the generation eligibility gate in this flow, **not** evidence that a human individually reviewed every AI-extracted fact.
- The optional **Source references** view allows inspection and adjustment. Editing fact text revokes its enabled status; changes require regeneration to affect existing drafts.
- Analysis failure preserves the current page's source, reports an error, and does not start generation. The app remains memory-only: refreshing loses the current work.

## Configuration and import limits

- `.env.example` uses the official DeepSeek endpoint and `deepseek-chat`. Put credentials only in an untracked `.env.local`.
- The default workspace includes a fixed test article; replace it with the intended source before generating production drafts.
- The browser extension reads an article the editor has opened and previews it before explicit import confirmation. It does not bypass access restrictions.
- The candidate server collector is disabled by default (`ARTICLE_COLLECTOR_V2=false`). Tests with public pages are not evidence that denied WikiFX articles can be fetched from the deployment host; see `server-collector.md`.

## Regression checks

With the production preview running, set `TEST_BASE_URL` as appropriate:

```sh
TEST_BASE_URL=http://localhost:3002 node scripts/test-fact-review.mjs
TEST_BASE_URL=http://localhost:3002 node scripts/test-analysis-shapes.mjs
TEST_BASE_URL=http://localhost:3002 node scripts/test-source-config.mjs
TEST_BASE_URL=http://localhost:3002 node scripts/test-source-handoff.mjs
```

These workflow checks mock AI responses and do not make paid model calls. Browser-extension and collector tests have their own fixtures; they do not establish live target-site access.
