import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { signIn } from './_login.mjs';
const browser = await chromium.launch();
let account;
try {
  const page = await browser.newPage();
  let analyzeRequests = 0;
  page.on('request', r => { if (r.url().includes('/api/analyze')) analyzeRequests++; });
  await page.route('**/api/fetch-article', r => r.fulfill({ status: 424, json: { code: 'SOURCE_ACCESS_DENIED', error: 'Denied' } }));
  account = await signIn(page, process.env.TEST_BASE_URL || 'http://localhost:3002');
  // The source panel opens on the URL tab; switch to paste/text tab to read textarea value
  await page.locator('.segmented-tab').nth(1).click();
  const oldText = await page.locator('.source-textarea').inputValue();
  await page.locator('.segmented-tab').nth(0).click();
  await page.locator('.url-input-row input').fill('https://example.com/new-article');
  await page.getByRole('button', { name: 'Fetch article', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'The website denied server access' }).waitFor();
  await page.locator('.segmented-tab').nth(1).click();
  assert.equal(await page.locator('.source-textarea').inputValue(), oldText);
  await page.getByRole('button', { name: 'Generate social drafts', exact: true }).click();
  assert.equal(analyzeRequests, 0);
  assert(await page.getByRole('button', { name: 'Export article JSON', exact: true }).isDisabled());
  // Editing or confirming the text clears the pending source error
  await page.locator('.source-textarea').fill(oldText + ' ');
  await page.locator('.source-textarea').fill(oldText);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export article JSON', exact: true }).click();
  const download = await downloadEvent;
  const payload = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.equal(payload.text, oldText);
  assert(payload.sourceUrl.includes('202609079764964517'));
  await page.locator('.source-textarea').fill('Temporary different source');
  await page.locator('input[type=file]').setInputFiles({ name: 'polaris-article.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  await page.waitForFunction(text => document.querySelector('.source-textarea')?.value === text, oldText);
  assert.equal(await page.locator('.info-banner[role="alert"]').count(), 0);
  console.log('PASS: access-denied message, stale source guard, JSON export and real JSON upload round-trip.');
} finally { if (account) await account.cleanup(); await browser.close(); }
