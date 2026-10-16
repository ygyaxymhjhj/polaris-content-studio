import assert from "node:assert/strict";
import { chromium } from "playwright";
import { openWorkspace, signIn } from "./_login.mjs";

// Run against an existing dev server: node scripts/test-ui-languages.mjs
const browser = await chromium.launch({ headless: true });
let account;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route('**/api/projects**', r => r.fulfill({json:{enabled:false,projects:[]}}));
  account = await signIn(page, process.env.TEST_BASE_URL || "http://localhost:3000");
  await openWorkspace(page);
  const language = page.locator('.language-menu-trigger');
  const chooseLanguage = async label => {
    await language.click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  };
  await chooseLanguage("简体中文");
  await page.getByRole("button", { name: "生成社媒文案全案", exact: true }).waitFor();
  // The source panel opens on the URL tab and keeps advanced fields collapsed; switch to the
  // text tab and expand the advanced section before touching those controls.
  await page.locator('.segmented-tab').nth(1).click();
  await page.locator('.source-textarea').fill("测试来源：不得因切换界面语言而改变。");
  await page.locator('.advanced-toggle-btn').click();
  const outputLanguage = page.locator('.input-grid select').nth(1);
  await outputLanguage.selectOption("vi");
  await chooseLanguage("Tiếng Việt");
  await page.getByRole("button", { name: "Tạo bản nháp mạng xã hội", exact: true }).waitFor();
  assert.equal(await page.locator('.source-textarea').inputValue(), "测试来源：不得因切换界面语言而改变。");
  assert.equal(await outputLanguage.inputValue(), "vi");
  await page.getByRole("button", { name: "Cài đặt", exact: true }).click();
  await page.getByRole("heading", { name: "Giọng điệu thương hiệu" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Tạo bản nháp mạng xã hội", exact: true }).waitFor();
  await language.click();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Tiếng Việt', exact: true }).getAttribute('aria-checked'), "true");
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('html').getAttribute('lang'), "vi");
  await chooseLanguage("English");
  await page.getByRole("button", { name: "Generate social drafts", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseLanguage("简体中文");
  assert.equal(await language.isVisible(), true);
  assert.deepEqual(errors, []);
  console.log("PASS: Chinese/Vietnamese/English UI, persistence, independent output language, source preservation, settings and mobile switcher.");
} finally {
  if (account) await account.cleanup();
  await browser.close();
}
