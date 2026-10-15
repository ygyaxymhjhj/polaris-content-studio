// Exercise the actual preview with React SSR; no server, credentials, or network is needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "cheerio";
import ts from "typescript";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRequire = createRequire(import.meta.url);
const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true
};
const transpile = source => ts.transpileModule(source, { compilerOptions }).outputText;
function loadModule(relativePath, mocks = {}) {
  const compiled = { exports: {} };
  const source = readFileSync(resolve(repository, relativePath), "utf8");
  new Function("require", "module", "exports", transpile(source))(
    name => mocks[name] ?? nativeRequire(name), compiled, compiled.exports
  );
  return compiled.exports;
}

const translations = loadModule("src/lib/i18n.tsx");
const SocialPreview = loadModule("src/components/SocialPreview.tsx", { "@/lib/i18n": translations }).default;
const studioSource = ts.createSourceFile("ContentStudio.tsx",
  readFileSync(resolve(repository, "src/components/ContentStudio.tsx"), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const labelDeclaration = studioSource.statements.find(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === "labelForAsset");
assert.ok(labelDeclaration, "Exercise the actual internal label helper without exporting it for tests");
const labelSource = ts.createPrinter().printNode(ts.EmitHint.Unspecified, labelDeclaration, studioSource);
const labelForAsset = new Function(`${transpile(labelSource)}; return labelForAsset;`)();

const singlePost = {
  id: "instagram-single-post",
  platform: "instagram",
  assetType: "short_post",
  title: "Fictional market update",
  content: "",
  factIds: [],
  riskFlags: [],
  updatedAt: "2026-10-14T00:00:00.000Z"
};
const legacySlides = Array.from({ length: 6 }, (_, index) => ({
  title: `Legacy slide ${index + 1}`,
  body: `Saved legacy body ${index + 1}`
}));
const legacyCarousel = {
  ...singlePost,
  id: "instagram-legacy-carousel",
  assetType: "carousel",
  content: "Existing legacy caption stays intact.",
  meta: { slides: legacySlides, slideCount: 99 }
};
function renderPreview(asset, language = "en", Preview = SocialPreview, imageUrl) {
  return load(renderToStaticMarkup(React.createElement(translations.LocaleContext.Provider, { value: language },
    React.createElement(Preview, { asset, imageUrl }))));
}
function assertSinglePost(document, asset) {
  assert.equal(document(".ig-caption-text").length, 1);
  assert.equal(document(".ig-caption-text").text(), asset.content, "Render the complete actual content, not meta.caption or an excerpt");
  assert.equal(document(".preview-card-instagram").text().split(asset.content).length - 1, 1,
    "The actual caption appears once within the preview, not in a fake slide copy");
  assert.equal(document(".ig-slide-card, .slide-nav-arrows, .slide-badge").length, 0);
  assert.equal(document(".preview-card-instagram button").length, 0, "A single post has no previous/next carousel controls");
  assert.equal(document(".preview-char-count").text(), `${asset.content.length} / 2200`);
  assert.doesNotMatch(document(".preview-card-instagram").text(), /1\s*\/\s*6|Carousel card preview/);
}

const localeCases = [
  ["en", "A complete English caption. ", "Post image preview"],
  ["zh", "完整的中文贴文正文。", "贴文配图预览"],
  ["vi", "Toàn bộ nội dung bài đăng tiếng Việt. ", "Xem trước ảnh bài đăng"],
  ["th", "เนื้อหาโพสต์ภาษาไทยฉบับเต็ม ", "ตัวอย่างภาพโพสต์"]
];
for (const [language, paragraph, placeholder] of localeCases) {
  const content = `${paragraph.repeat(12)}\n\n#Polaris`;
  const asset = { ...singlePost, content, meta: { caption: "Stale caption must not replace edited content" } };
  const translate = text => translations.translate(language, text);
  assert.equal(labelForAsset(asset, translate), translate("short post"));
  const withoutImage = renderPreview(asset, language);
  assertSinglePost(withoutImage, asset);
  assert.equal(withoutImage(".mock-image-fallback").text().trim(), placeholder);
  assert.equal(withoutImage(".ig-media img").length, 0);
  const withImage = renderPreview({ ...asset, imageUrl: "https://example.test/post.jpg" }, language);
  assertSinglePost(withImage, asset);
  assert.equal(withImage(".ig-media img").attr("src"), "https://example.test/post.jpg");
  assert.equal(withImage(".mock-image-fallback").length, 0);
  assert.equal(labelForAsset(legacyCarousel, translate), `${translate("carousel")} \u00b7 6 ${translate("slides")}`,
    "Legacy page labels use the real slides array, never stale slideCount");
  const legacyDocument = renderPreview(legacyCarousel, language);
  assert.equal(legacyDocument(".slide-badge").text(), `${translate("Slides")} 1 / 6`);
  assert.equal(legacyDocument(".ig-slide-body h4").text(), "Legacy slide 1");
  assert.equal(legacyDocument(".slide-nav-arrows button").length, 2);
  assert.equal(legacyDocument(".slide-nav-arrows button").first().is("[disabled]"), true);
  assert.equal(legacyDocument(".slide-nav-arrows button").last().is("[disabled]"), false);
  assert.equal(legacyDocument(".ig-caption-text").text(), legacyCarousel.content);
}
console.log("PASS: four locales render one complete Instagram caption, a single image/translated placeholder, 2200 counter, and truthful legacy six-slide labels/previews.");

for (const meta of [undefined, { slideCount: 6 }, { slides: [] }, { slides: "not-an-array" }, { slides: { length: 6 } }, { slides: legacySlides, slideCount: 6 }]) {
  const asset = { ...singlePost, content: "A single post ignores obsolete slide metadata.", meta };
  assertSinglePost(renderPreview(asset), asset);
  assert.equal(labelForAsset(asset, text => text), "short post");
}
for (const slides of [undefined, [], "not-an-array", { length: 6 }]) {
  const asset = { ...legacyCarousel, meta: { slides, slideCount: 6 } };
  assert.equal(labelForAsset(asset, text => text), "carousel");
  assert.equal(renderPreview(asset)(".ig-slide-card, .slide-nav-arrows").length, 0);
}
const imageOverride = renderPreview({ ...singlePost, imageUrl: "https://example.test/original.jpg" }, "en", SocialPreview, "https://example.test/override.jpg");
assert.equal(imageOverride(".ig-media img").attr("src"), "https://example.test/override.jpg");
for (const content of ["A".repeat(2200), "A".repeat(2201), "Full caption with emoji: 🌍\n#Polaris"]) {
  const asset = { ...singlePost, content };
  assertSinglePost(renderPreview(asset), asset);
}
console.log("PASS: stale single-post metadata cannot create a carousel; absent/malformed legacy slides cannot invent six pages; image override is preserved.");

// Keep React's actual SSR renderer; inject only an old hook index to exercise a props-change boundary.
const PreviewWithStaleIndex = loadModule("src/components/SocialPreview.tsx", {
  "@/lib/i18n": translations,
  react: { ...React, useState: () => [5, () => {}] }
}).default;
const shorterCarousel = { ...legacyCarousel, meta: { slides: legacySlides.slice(0, 2) } };
const clampedDocument = renderPreview(shorterCarousel, "en", PreviewWithStaleIndex);
assert.equal(clampedDocument(".slide-badge").text(), "Slides 2 / 2");
assert.equal(clampedDocument(".ig-slide-body h4").text(), "Legacy slide 2");
assert.equal(clampedDocument(".slide-nav-arrows button").last().is("[disabled]"), true);
assertSinglePost(renderPreview({ ...singlePost, content: "Switching back to one post remains safe." }, "en", PreviewWithStaleIndex),
  { ...singlePost, content: "Switching back to one post remains safe." });
for (const platform of ["x", "linkedin", "facebook", "threads"]) {
  const asset = { ...singlePost, platform, content: "Other platform formatting is unchanged." };
  const document = renderPreview(asset);
  assert.equal(document(".preview-char-count").text(), `${asset.content.length} characters`);
  assert.equal(document(".mock-content-text").text(), asset.content);
}
console.log("PASS: a stale carousel index clamps to the actual slide range, initial index remains zero, and other platform character counters are unchanged.");
