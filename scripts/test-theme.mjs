// Theme regression: the pure clock rules, the pre-paint bootstrap script, and the real switch.
// The logic sections need no server; the browser section talks to TEST_BASE_URL and is skipped
// when nothing is listening. Run: node scripts/test-theme.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import typescript from "typescript";
import { chromium } from "playwright";

const nativeRequire = createRequire(import.meta.url);

function loadModule(relativePath) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const { outputText } = typescript.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", outputText)(
    dependency => nativeRequire(dependency),
    compiledModule,
    compiledModule.exports
  );
  return compiledModule.exports;
}

const theme = loadModule("../src/lib/theme.ts");

/* ------------------------------------------------------------------ *
 * 1. The automatic window.
 * ------------------------------------------------------------------ */

test("the light window is 07:00 until 19:00, inclusive of the start and exclusive of the end", () => {
  assert.equal(theme.resolveAutomaticTheme(0), "dark", "midnight is dark");
  assert.equal(theme.resolveAutomaticTheme(6), "dark", "06:59 stays dark");
  assert.equal(theme.resolveAutomaticTheme(7), "light", "07:00 turns light");
  assert.equal(theme.resolveAutomaticTheme(12), "light");
  assert.equal(theme.resolveAutomaticTheme(18), "light", "18:59 is still light");
  assert.equal(theme.resolveAutomaticTheme(19), "dark", "19:00 turns dark");
  assert.equal(theme.resolveAutomaticTheme(23), "dark");
});

test("automatic mode reads the given clock, and a manual mode ignores it", () => {
  const night = new Date("2026-10-15T22:30:00");
  const day = new Date("2026-10-15T09:15:00");
  assert.equal(theme.resolveTheme("auto", night), "dark");
  assert.equal(theme.resolveTheme("auto", day), "light");
  assert.equal(theme.resolveTheme("light", night), "light", "a pinned light theme survives the night");
  assert.equal(theme.resolveTheme("dark", day), "dark", "a pinned dark theme survives the day");
});

test("the next check lands on the coming boundary, capped at one minute", () => {
  const justBeforeDawn = new Date("2026-10-15T06:59:30");
  const boundaryIn = theme.millisecondsUntilNextThemeBoundary(justBeforeDawn);
  assert.equal(boundaryIn, 30_000, "06:59:30 waits 30 seconds for 07:00");
  assert.equal(theme.nextThemeCheckDelay(justBeforeDawn), 31_000);

  const midday = new Date("2026-10-15T12:00:00");
  assert.equal(theme.millisecondsUntilNextThemeBoundary(midday), 7 * 3_600_000, "noon waits for 19:00");
  assert.equal(theme.nextThemeCheckDelay(midday), theme.THEME_RECHECK_INTERVAL_MS, "a long wait is capped");

  const afterDusk = new Date("2026-10-15T19:00:00");
  assert.equal(theme.millisecondsUntilNextThemeBoundary(afterDusk), 12 * 3_600_000, "19:00 waits for tomorrow's 07:00");

  const lateEvening = new Date("2026-10-15T23:30:00");
  const toMorning = theme.millisecondsUntilNextThemeBoundary(lateEvening);
  assert.equal(toMorning, 7.5 * 3_600_000, "23:30 crosses midnight into the next light window");
  assert.equal(theme.resolveTheme("auto", new Date(lateEvening.getTime() + toMorning)), "light");
});

test("an unknown or unreadable stored value falls back to automatic", () => {
  assert.equal(theme.parseThemeMode("dark"), "dark");
  assert.equal(theme.parseThemeMode("light"), "light");
  assert.equal(theme.parseThemeMode("auto"), "auto");
  for (const invalid of [null, undefined, "", "DARK", "system", "0", {}]) {
    assert.equal(theme.parseThemeMode(invalid), "auto", `${String(invalid)} must fall back to automatic`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. The bootstrap script must agree with the runtime.
 * ------------------------------------------------------------------ */

/** Runs a callback with the device clock pinned to one hour. */
function withClock(hour, run) {
  const originalGetHours = Date.prototype.getHours;
  Date.prototype.getHours = () => hour;
  try {
    return run();
  } finally {
    Date.prototype.getHours = originalGetHours;
  }
}

/** Runs the shipped script against a stub document and window, exactly as the browser would. */
function runBootstrap(hour, stored) {
  const attributes = {};
  const document = { documentElement: { setAttribute: (name, value) => { attributes[name] = value; }, style: {} } };
  const window = {
    localStorage: {
      getItem: () => {
        if (stored === "__throws__") throw new Error("storage blocked");
        return stored;
      }
    }
  };
  return withClock(hour, () => {
    new Function("document", "window", theme.THEME_BOOTSTRAP_SCRIPT)(document, window);
    return { attributes, colorScheme: document.documentElement.style.colorScheme };
  });
}

test("the first paint agrees with the runtime for every hour and stored mode", () => {
  for (let hour = 0; hour < 24; hour += 1) {
    for (const stored of [null, "auto", "light", "dark", "unexpected", "__throws__"]) {
      const { attributes, colorScheme } = runBootstrap(hour, stored);
      const mode = theme.parseThemeMode(stored === "__throws__" ? null : stored);
      // Both sides read the same pinned clock, so the shipped script can never drift from the
      // runtime that produced it.
      const expected = withClock(hour, () => theme.resolveTheme(mode));
      assert.equal(attributes["data-theme"], expected, `hour ${hour}, stored ${stored}`);
      assert.equal(attributes["data-theme-mode"], mode, `mode for stored ${stored}`);
      assert.equal(colorScheme, expected, "native controls follow the theme");
    }
  }
});

test("the bootstrap script writes both the theme and the mode attributes", () => {
  const { attributes } = runBootstrap(22, "light");
  assert.equal(attributes["data-theme"], "light");
  assert.equal(attributes["data-theme-mode"], "light");
  assert.equal(runBootstrap(22, null).attributes["data-theme"], "dark");
  assert.equal(runBootstrap(9, null).attributes["data-theme"], "light");
});

test("the script is a fixed payload with no user input interpolated", () => {
  assert.ok(!theme.THEME_BOOTSTRAP_SCRIPT.includes("${"));
  assert.ok(!theme.THEME_BOOTSTRAP_SCRIPT.includes("</script"));
  assert.ok(theme.THEME_BOOTSTRAP_SCRIPT.startsWith("(function(){"));
  assert.ok(theme.THEME_BOOTSTRAP_SCRIPT.endsWith("})();"));
});

/* ------------------------------------------------------------------ *
 * 2b. The stylesheet must not pair a theme token with a fixed surface.
 * ------------------------------------------------------------------ */

const stylesheet = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

function relativeLuminance(hexValue) {
  const text = hexValue.replace("#", "");
  const full = text.length === 3 ? [...text].map(character => character + character).join("") : text;
  if (full.length !== 6) return null;
  const [r, g, b] = [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16) / 255);
  const channel = value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * A background that is pinned to a near-white or near-black literal cannot follow the theme, so
 * pairing it with a colour that does is how text becomes invisible in one of the two modes. The
 * simulated social card is excluded: it deliberately keeps its own light palette.
 */
function findMismatchedThemePairs(css) {
  const previewStart = css.indexOf("/* Social Preview Component */");
  const previewEnd = css.indexOf("/* Modal Backdrop & Publish Dialog */");
  const region = css.slice(0, previewStart) + css.slice(previewEnd);
  const offenders = [];
  for (const rule of region.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = rule[1].split("\n").pop().trim().replace(/\s+/g, " ").slice(0, 60);
    const background = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(rule[2]);
    const colour = /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(rule[2]);
    if (!background || !colour) continue;
    if (background[1].includes("var(") || background[1].includes("gradient")) continue;
    // `transparent` is not a surface: the element shows whatever is behind it, which follows the theme.
    if (/^(transparent|none|inherit|unset|initial|currentcolor)$/i.test(background[1].trim())) continue;
    if (!/var\(--(text|ink|btn|accent-soft|surface)/.test(colour[1])) continue;
    const literals = ["white", ...background[1].match(/#[0-9a-fA-F]{3,8}/g) || []];
    for (const literal of literals) {
      const luminance = literal === "white" ? 1 : relativeLuminance(literal);
      if (luminance === null) continue;
      if (luminance > 0.6 || luminance < 0.25) {
        offenders.push(`${selector} background: ${background[1].trim()} with color: ${colour[1].trim()}`);
      }
    }
  }
  return offenders;
}

test("no rule pairs a fixed light or dark surface with a theme-dependent colour", () => {
  assert.deepEqual(findMismatchedThemePairs(stylesheet), []);
});

test("the surfaces and text a switch relies on resolve from tokens", () => {
  // These two were the reported bug: a literal white surface under theme-dependent text.
  assert.match(stylesheet, /\.url-input-row input \{[^}]*background: var\(--surface-input\)/);
  assert.match(stylesheet, /\.locale-switcher select \{[^}]*background: var\(--surface-input\)/);
  // Roughly one in twenty surfaces stays intentional, so a floor keeps this from passing on nothing.
  const tokenSurfaces = stylesheet.match(/background(?:-color)?: var\(--/g) || [];
  assert.ok(tokenSurfaces.length > 60, `expected many token surfaces, found ${tokenSurfaces.length}`);
});

/* ------------------------------------------------------------------ *
 * 3. The switch itself, against a running server.
 * ------------------------------------------------------------------ */

const base = process.env.TEST_BASE_URL || "http://localhost:3002";

async function serverReachable() {
  try {
    const response = await fetch(`${base}/login`, { redirect: "manual" });
    return response.status < 500;
  } catch {
    return false;
  }
}

const reachable = await serverReachable();

/**
 * Prefers Playwright's bundled Chromium, and falls back to a locally installed Chrome when the
 * bundled download is missing.
 */
async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!/Executable doesn't exist/.test(String(error))) throw error;
    return await chromium.launch({ headless: true, channel: "chrome" });
  }
}

test("the switch follows the clock, persists a manual choice and can return to automatic", { skip: !reachable && "no server on TEST_BASE_URL" }, async () => {
  const browser = await launchBrowser();
  try {
    // The page's own clock reports the middle of the night, so automatic mode must resolve dark.
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      Date.prototype.getHours = () => 22;
    });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.goto(`${base}/login`);

    const root = page.locator("html");
    assert.equal(await root.getAttribute("data-theme"), "dark", "a night visitor gets the dark theme before hydration");
    assert.equal(await root.getAttribute("data-theme-mode"), "auto");

    // The glyph is chosen in CSS from the root attributes, so the moon must be the visible one.
    assert.equal(await page.locator(".theme-glyph-dark").isVisible(), true);
    assert.equal(await page.locator(".theme-glyph-light").isVisible(), false);
    assert.equal(await page.locator(".theme-toggle-auto").isVisible(), true, "automatic mode is marked");

    const trigger = page.locator(".theme-toggle-trigger");
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Appearance" });
    await menu.waitFor();
    assert.equal(await page.getByRole("menuitemradio", { name: /Automatic/ }).getAttribute("aria-checked"), "true");
    assert.equal(await page.getByRole("menuitemradio", { name: /^Light/ }).getAttribute("aria-checked"), "false");

    // The trigger sits inside the sign-in form, so opening it must never submit the form, and a
    // theme change must leave whatever the reader had typed exactly where it was.
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await page.locator('.login-panel input[autocomplete="username"]').fill("typed-but-unsent");
    await trigger.click();
    await menu.waitFor();
    await page.getByRole("menuitemradio", { name: /^Light/ }).click();
    assert.equal(await page.locator('.login-panel input[autocomplete="username"]').inputValue(), "typed-but-unsent");
    assert.equal(page.url().includes("/login"), true, "the switch must not navigate or submit");
    assert.equal(await page.locator(".login-error").count(), 0, "no sign-in attempt was triggered");
    assert.equal(await root.getAttribute("data-theme"), "light", "the light choice applies immediately");
    assert.equal(await root.getAttribute("data-theme-mode"), "light");
    assert.equal(await page.evaluate(() => window.localStorage.getItem("polaris-theme-mode")), "light");

    // The clock alone must not override a pinned choice, even after the page resumes.
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
    await page.waitForTimeout(300);
    assert.equal(await root.getAttribute("data-theme"), "light");

    await page.reload();
    assert.equal(await root.getAttribute("data-theme"), "light", "the choice survives a reload");
    assert.equal(await page.locator(".theme-glyph-light").isVisible(), true);
    assert.equal(await page.locator(".theme-toggle-auto").isVisible(), false, "a pinned choice is not marked automatic");

    // The login navigation is a full page load, so the theme must be right on the first paint.
    await page.goto(`${base}/login`);
    assert.equal(await root.getAttribute("data-theme"), "light");

    await trigger.click();
    await page.getByRole("menuitemradio", { name: /Automatic/ }).click();
    assert.equal(await root.getAttribute("data-theme"), "dark", "automatic re-reads the clock");
    assert.equal(await page.evaluate(() => window.localStorage.getItem("polaris-theme-mode")), "auto");

    // Escape closes the popover and restores focus to the trigger.
    await trigger.click();
    await menu.waitFor();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("theme-toggle-trigger")), true);
    assert.deepEqual(pageErrors, [], "no page errors while switching themes");
    // A hydration mismatch would be reported here rather than as a page error.
    assert.deepEqual(consoleErrors.filter(text => /hydrat|did not match|server rendered/i.test(text)), [], "no hydration warnings");

    // A second tab of the same site follows the change.
    const secondPage = await context.newPage();
    await secondPage.goto(`${base}/login`);
    assert.equal(await secondPage.locator("html").getAttribute("data-theme"), "dark");
    await trigger.click();
    await page.getByRole("menuitemradio", { name: /^Light/ }).click();
    await secondPage.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light", null, { timeout: 5000 });

    // The switch stays reachable on the narrow rail.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/login`);
    assert.equal(await page.locator(".theme-toggle-trigger").isVisible(), true, "the switch is visible on a phone viewport");
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors.filter(text => /hydrat|did not match|server rendered/i.test(text)), []);
    await context.close();
  } finally {
    await browser.close();
  }
});

console.log(reachable
  ? "Theme tests ran with the browser section."
  : `Theme logic passed; browser section skipped (nothing listening on ${base}).`);
