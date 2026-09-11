import assert from "node:assert/strict";
import { chromium } from "playwright";

// Run against an existing dev server: node scripts/test-ui-languages.mjs
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(process.env.TEST_BASE_URL || "http://localhost:3000");
  const language = page.locator('.locale-switcher select');
  await language.selectOption("zh");
  await page.getByRole("button", { name: "分析来源", exact: true }).waitFor();
  await page.locator('.source-textarea').fill("测试来源：不得因切换界面语言而改变。");
  const outputLanguage = page.locator('select').nth(2);
  await outputLanguage.selectOption("vi");
  await language.selectOption("vi");
  await page.getByRole("button", { name: "Phân tích nguồn", exact: true }).waitFor();
  assert.equal(await page.locator('.source-textarea').inputValue(), "测试来源：不得因切换界面语言而改变。");
  assert.equal(await outputLanguage.inputValue(), "vi");
  await page.getByRole("button", { name: "Cài đặt", exact: true }).click();
  await page.getByRole("heading", { name: "Giọng điệu thương hiệu" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Phân tích nguồn", exact: true }).waitFor();
  assert.equal(await language.inputValue(), "vi");
  assert.equal(await page.locator('html').getAttribute('lang'), "vi");
  await language.selectOption("en");
  await page.getByRole("button", { name: "Analyze source", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await language.selectOption("zh");
  assert.equal(await language.isVisible(), true);
  assert.deepEqual(errors, []);
  console.log("PASS: Chinese/Vietnamese/English UI, persistence, independent output language, source preservation, settings and mobile switcher.");
} finally {
  await browser.close();
}
