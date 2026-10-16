// Regression for the draft dialog's account chooser. Selecting an account used to fire the
// neighbouring "Manage accounts" button, because the whole field was wrapped in a <label> and a
// label forwards activation clicks from its non-interactive contents to its labeled control.
// Needs a running app and MySQL; the AI and Postiz calls are mocked, so no paid requests.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openWorkspace, signIn } from './_login.mjs';

const base = process.env.TEST_BASE_URL || 'http://localhost:3002';
const accounts = [
  { id: 'acct-first', name: 'First Desk', identifier: 'x', disabled: false, ownerUserId: null, ownerName: null },
  { id: 'acct-second', name: 'Second Desk', identifier: 'x', disabled: false, ownerUserId: null, ownerName: null }
];
const analysis = {
  summaryShort: 'Dialog regression source',
  summaryLong: 'Fictional source for the publish dialog regression.',
  keyTerms: ['Regression'],
  riskFlags: [],
  facts: [{
    id: 'F001',
    type: 'claim',
    text: 'Example Company opens at 09:00.',
    sourceExcerpt: 'Example Company opens at 09:00 and closes at 17:00.',
    sourceLocation: 'Test',
    verified: false,
    usableOnSocial: true,
    riskLevel: 'low'
  }]
};

const connectDialogCount = (page) => page.locator('.connect-dialog').count();
// textContent, not innerText: the card uppercases its name with CSS, so innerText returns "FIRST DESK".
const selectedAccountName = (page) => page.locator('.account-option-card.selected strong').evaluate((element) => element.textContent);

const browser = await chromium.launch();
let account;
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.route('**/api/analyze', (route) => route.fulfill({ json: analysis }));
  await page.route('**/api/generate', (route) => {
    const platform = route.request().postDataJSON().platforms[0];
    return route.fulfill({
      json: {
        assets: [{
          id: `dialog-regression-${platform}`,
          platform,
          assetType: 'post',
          title: `Dialog regression ${platform}`,
          content: 'Fictional content for the dialog regression.',
          cta: 'Read the test',
          factIds: ['F001'],
          riskFlags: [],
          generationMode: 'ai',
          meta: {},
          updatedAt: new Date().toISOString()
        }],
        usedFallback: false
      }
    });
  });
  await page.route('**/api/social/channels', (route) => route.fulfill({
    json: { configured: true, oauthConfigured: true, uiUrl: 'https://postiz.example.test', accounts }
  }));

  account = await signIn(page, base, { displayName: 'Dialog Test' });
  await openWorkspace(page);
  await page.locator('.segmented-tab').nth(1).click();
  await page.locator('.source-textarea').fill('Fictional regression source. Example Company opens at 09:00 and closes at 17:00. '.repeat(4));
  await page.locator('.distribution-panel .panel-actions .primary-button').click();
  await page.waitForFunction(() => document.querySelectorAll('.asset-card:not(.skeleton)').length > 0, null, { timeout: 30000 });
  await page.locator('.asset-card').first().click();
  await page.locator('.drawer-footer button', { hasText: /Postiz draft/i }).click();
  await page.waitForFunction(() => document.querySelectorAll('.account-option-card').length === 2, null, { timeout: 15000 });

  assert.equal(await selectedAccountName(page), 'First Desk', 'The first account starts selected');
  assert.equal(await connectDialogCount(page), 0);

  await page.locator('.account-option-card', { hasText: 'Second Desk' }).click();
  assert.equal(await selectedAccountName(page), 'Second Desk', 'Clicking another account selects it');
  assert.equal(await connectDialogCount(page), 0, 'Selecting an account must not open the manage-accounts dialog');

  await page.locator('.account-option-card', { hasText: 'First Desk' }).click();
  assert.equal(await selectedAccountName(page), 'First Desk', 'Selecting the first account again selects it');
  assert.equal(await connectDialogCount(page), 0, 'Selecting an account must not open the manage-accounts dialog');

  // Click the caption text itself, not the header row's centre: the row also holds the buttons.
  await page.locator('.publish-dialog .dialog-body > .field-label > span').first().click({ position: { x: 8, y: 14 } });
  assert.equal(await connectDialogCount(page), 0, 'Clicking the account field caption must not open the manage-accounts dialog');

  await page.locator('.publish-dialog .small-button', { hasText: /Manage accounts/i }).click();
  await page.locator('.connect-dialog').waitFor({ timeout: 5000 });

  assert.deepEqual(errors, []);
  console.log('PASS: account cards select without opening the manage-accounts dialog; the caption is inert; the Manage accounts button still opens it.');
} finally {
  await browser.close();
  if (account) await account.cleanup();
}
