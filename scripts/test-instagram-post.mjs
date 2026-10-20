import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "polaris-instagram-"));
const originalFetch = globalThis.fetch;
const originalKey = process.env.AI_API_KEY;
try {
  for (const moduleName of ["types", "asset-specs", "context-budget", "source-config", "social-guidelines", "starter-assets", "ai"]) {
    const source = await fs.readFile(`src/lib/${moduleName}.ts`, "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    await fs.writeFile(path.join(temporaryDirectory, `${moduleName}.js`), outputText);
  }
  const require = createRequire(import.meta.url);
  const { starterAssets } = require(path.join(temporaryDirectory, "starter-assets.js"));
  const { generateWithAI, rewriteAsset } = require(path.join(temporaryDirectory, "ai.js"));
  const { ASSET_SPECS, ASSET_TYPES, assetQualityIssues } = require(path.join(temporaryDirectory, "asset-specs.js"));
  const { channelVoice } = require(path.join(temporaryDirectory, "social-guidelines.js"));
  const config = { name: "Test", title: "Source update", language: "en", category: "", audience: "Readers", cta: "", sourceUrl: "https://example.com/news", websiteUrl: "", tone: "", publishDate: "" };
  const sourceTexts = {
    en: "The notice states that the published fee is 1.4%, effective on 14 October. Readers can consult the original notice for its scope and conditions.",
    zh: "公告表示，新公布的费率为1.4%，自10月14日起生效。读者可查看原始公告，了解其适用范围及具体条件；以上信息以公告列出的条款为准。公告同时提供了相关费用适用对象的说明，具体细节请参照原始文件。",
    vi: "Thông báo nêu mức phí được công bố là 1,4%, có hiệu lực từ ngày 14 tháng 10. Người đọc có thể xem thông báo gốc để biết phạm vi và điều kiện áp dụng.",
    th: "ประกาศระบุว่าอัตราค่าธรรมเนียมที่เผยแพร่คือ 1.4% มีผลตั้งแต่วันที่ 14 ตุลาคม ผู้อ่านสามารถตรวจสอบขอบเขตและเงื่อนไขการใช้งานได้จากประกาศต้นฉบับ"
  };
  const analysisFor = text => ({ summaryShort: "NOT_VERIFIED_SUMMARY", summaryLong: "NOT_VERIFIED_SUMMARY", keyTerms: [], riskFlags: [], facts: [{ id: "F001", text, sourceExcerpt: text, sourceLocation: "Source", type: "claim", verified: true, usableOnSocial: true, riskLevel: "low" }] });
  const analysis = analysisFor(sourceTexts.en);
  const modelAsset = content => ({ platform: "instagram", assetType: "carousel", title: "Internal title", content, factIds: ["F001"], riskFlags: [], meta: { caption: "stale caption", visualBrief: "Neutral editorial image" }, changeSummary: "Updated caption" });
  const assertSinglePost = asset => {
    assert.equal(asset.assetType, "short_post");
    assert(asset.content.length <= 2200, `Caption exceeds 2200: ${asset.content.length}`);
    assert.equal(asset.meta.caption, asset.content);
    for (const key of ["slides", "slideCount", "visualDirections"]) assert(!Object.hasOwn(asset.meta, key));
    assert(!/^\s*[1-6]\s*\/\s*6\b/m.test(asset.content));
    assert(!asset.content.includes("NOT_VERIFIED_SUMMARY"));
  };
  const requests = [];
  let replies = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    assert(replies.length, "Unexpected synthetic AI call");
    return Response.json({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }] });
  };

  assert.equal(ASSET_TYPES.instagram, "short_post", "Instagram is one formal post, not a carousel");
  assert.equal(ASSET_SPECS.instagram.count, 1);
  assert.deepEqual(ASSET_SPECS.instagram.notes, ["caption", "visualBrief"]);
  for (const language of ["en", "zh", "vi", "th"]) {
    const localizedConfig = { ...config, language, title: "" };
    const localizedAnalysis = analysisFor(sourceTexts[language]);
    delete process.env.AI_API_KEY;
    const offline = await generateWithAI(localizedConfig, localizedAnalysis, ["instagram"]);
    assert.equal(offline.assets.length, 1);
    assertSinglePost(offline.assets[0]);
    assert(offline.assets[0].content.includes(sourceTexts[language]));
    assert(!offline.assets[0].content.includes(offline.assets[0].meta.visualBrief));
    if (language === "th") {
      assert(offline.assets[0].content.includes("อ่านบทความฉบับเต็ม"));
      assert(/[\u0e00-\u0e7f]/.test(offline.assets[0].meta.visualBrief));
      assert(/[\u0e00-\u0e7f]/.test(offline.assets[0].riskFlags[0]));
    }
    assert.equal(channelVoice("instagram", language).language, language);
    assert(channelVoice("instagram", language).guidelines.includes("2200"));
    process.env.AI_API_KEY = "synthetic-only";
    replies = [{ assets: [modelAsset(sourceTexts[language])] }];
    requests.length = 0;
    const generated = await generateWithAI(localizedConfig, localizedAnalysis, ["instagram"]);
    assertSinglePost(generated.assets[0]);
    assert.equal(generated.assets[0].generationMode, "ai");
    assert.equal(requests.length, 1, "Short source is not padded to the old carousel minimum");
    const generationPrompt = requests[0].messages[1].content;
    assert(generationPrompt.includes(`must use language ${language}`));
    assert(generationPrompt.includes("2200"));
    assert(generationPrompt.includes("one standalone finished post"));
    assert.equal(generationPrompt.includes("60-100 words"), language === "en", "The shorter caption target applies only to English");
    if (language === "en") {
      assert(generationPrompt.includes("1-2 short paragraphs"), "English Instagram captions prefer fewer paragraphs");
      assert(generationPrompt.includes("ceiling, not a length target"), "The publishing limit must not encourage padding");
    }
    const legacy = { ...generated.assets[0], assetType: "carousel", meta: { slides: [{ title: "Old slide" }], slideCount: 6, visualDirections: ["Old directions"] } };
    replies = [{ candidates: Array.from({ length: 3 }, () => modelAsset(sourceTexts[language])) }];
    requests.length = 0;
    const rewritten = await rewriteAsset(localizedConfig, localizedAnalysis, legacy, [], "Improve the opening", 3);
    assert.equal(rewritten.candidates.length, 3, "Three options remain three independent posts");
    rewritten.candidates.forEach(candidate => assertSinglePost(candidate.asset));
    const rewritePrompt = requests[0].messages[1].content;
    assert(rewritePrompt.includes('assetType="short_post"'));
    assert(requests[0].messages[0].content.includes("legacy Instagram"));
    assert(rewritePrompt.includes("2200"));
    assert.equal(rewritePrompt.includes("60-100 words"), language === "en", "Revisions receive the same English-only length guidance");
  }

  const complete = modelAsset("a".repeat(2200));
  const checked = content => ({ ...complete, assetType: "short_post", content, meta: { caption: content, visualBrief: "Image" } });
  assert.deepEqual(assetQualityIssues(checked("a".repeat(2200))), []);
  assert(assetQualityIssues(checked("a".repeat(2201))).some(issue => issue.includes("2200")));
  assert.deepEqual(assetQualityIssues(checked("😀".repeat(1100))), []);
  assert(assetQualityIssues(checked("😀".repeat(1101))).some(issue => issue.includes("2200")));
  const withExtras = "a".repeat(2170) + "\n\nRead more #News\nhttps://example.com/news";
  assert(assetQualityIssues(checked(withExtras)).some(issue => issue.includes("2200")), "CTA, hashtags, URL and newlines count");
  assert(assetQualityIssues({ ...checked(sourceTexts.en), meta: { ...checked(sourceTexts.en).meta, slides: [] } }).length);
  assert(assetQualityIssues(checked("1/6 — Hook\n\n2/6 — Details")).some(issue => /single|carousel/i.test(issue)));
  assert(assetQualityIssues(checked("1/6 Hook\n\n2/6 Details")).some(issue => /single|carousel/i.test(issue)));
  for (const label of ["Caption: ", "发布配文：", "Chú thích bài đăng: ", "คำบรรยายโพสต์: "]) {
    assert(assetQualityIssues(checked(label + sourceTexts.en)).some(issue => /label/i.test(issue)));
  }
  assert(assetQualityIssues({ ...checked(sourceTexts.en), slides: [] }).some(issue => /single|carousel/i.test(issue)));

  process.env.AI_API_KEY = "synthetic-only";
  requests.length = 0;
  replies = [{ assets: [modelAsset("a".repeat(2201))] }, { assets: [modelAsset(sourceTexts.en)] }];
  const retried = await generateWithAI(config, analysis, ["instagram"]);
  assert.equal(requests.length, 2);
  assert.equal(retried.assets[0].content, sourceTexts.en);
  assertSinglePost(retried.assets[0]);
  assert(requests[1].messages[1].content.includes("2200"));
  replies = [{ assets: [modelAsset("a".repeat(2201))] }, { assets: [modelAsset("The fee is 1.4%.")] }];
  const shortRetry = await generateWithAI(config, analysisFor("The fee is 1.4%."), ["instagram"]);
  assert.equal(shortRetry.assets[0].content, "The fee is 1.4%.", "A short valid caption beats an equally flagged oversized draft");
  assert.equal(shortRetry.assets[0].generationMode, "ai");
  replies = [{ assets: [{ ...modelAsset(sourceTexts.en), slides: [{ title: "Legacy slide" }] }] }, { assets: [modelAsset(sourceTexts.en)] }];
  const topLevelSlides = await generateWithAI(config, analysis, ["instagram"]);
  assert(!Object.hasOwn(topLevelSlides.assets[0], "slides"));
  requests.length = 0;
  replies = [{ assets: [modelAsset("a".repeat(2201))] }, { assets: [modelAsset("b".repeat(2300))] }];
  const fallback = await generateWithAI(config, analysis, ["instagram"]);
  assert.equal(requests.length, 2);
  assert.equal(fallback.usedFallback, true);
  assert.equal(fallback.assets[0].generationMode, "local");
  assertSinglePost(fallback.assets[0]);
  for (const legacyCopy of ["1/6 — Hook\n\n2/6 — Details", sourceTexts.en]) {
    replies = [{ assets: [{ ...modelAsset(legacyCopy), meta: { slides: [{ title: "Slide" }], caption: legacyCopy, visualBrief: "Image" } }] }, { assets: [modelAsset(sourceTexts.en)] }];
    const converted = await generateWithAI(config, analysis, ["instagram"]);
    assertSinglePost(converted.assets[0]);
    assert.equal(converted.assets[0].content, sourceTexts.en);
  }

  const baseAsset = { ...checked(sourceTexts.en), id: "existing-instagram" };
  requests.length = 0;
  replies = [{ candidates: [modelAsset("a".repeat(2201))] }, { candidates: [modelAsset(sourceTexts.en)] }];
  const rewriteRetry = await rewriteAsset(config, analysis, baseAsset, [], "Make it clearer", 1);
  assert.equal(requests.length, 2);
  assert.equal(rewriteRetry.candidates.length, 1);
  assertSinglePost(rewriteRetry.candidates[0].asset);
  requests.length = 0;
  replies = [{ candidates: [modelAsset("a".repeat(2201))] }, { candidates: [modelAsset("b".repeat(2300))] }];
  const rewriteRejected = await rewriteAsset(config, analysis, baseAsset, [], "Make it clearer", 1);
  assert.equal(requests.length, 2);
  assert.equal(rewriteRejected.candidates.length, 0);
  assert(rewriteRejected.reason?.includes("2200"));

  const oversizedFact = "A".repeat(2300) + " 1.4%";
  const mixedAnalysis = { ...analysis, facts: [{ ...analysis.facts[0], id: "TOO_LONG", text: oversizedFact }, ...analysis.facts] };
  const bounded = starterAssets({ ...config, title: "T".repeat(2300), cta: "C".repeat(2300) }, mixedAnalysis, ["instagram"]).assets[0];
  assertSinglePost(bounded);
  assert.deepEqual(bounded.factIds, ["F001"], "Only facts actually included are referenced");
  assert.equal(bounded.content, sourceTexts.en, "Whole facts survive when title and CTA cannot fit");
  const needsEditing = starterAssets(config, analysisFor(oversizedFact), ["instagram"]).assets[0];
  assertSinglePost(needsEditing);
  assert.deepEqual(needsEditing.factIds, []);
  assert(needsEditing.riskFlags.some(flag => /cannot fit|not publishable/i.test(flag)));
  assert(!needsEditing.content.includes("1.4%"), "Oversized facts are never cut midway");
  const shortFact = "The fee is 1.4%.";
  const exactBudget = starterAssets({ ...config, title: "", cta: "", sourceUrl: "" }, analysisFor(shortFact), ["instagram"]).assets[0];
  assert(exactBudget.content.includes(shortFact));
  assert.deepEqual(exactBudget.factIds, ["F001"]);
  console.log("Instagram single-post contracts passed (offline and synthetic AI, four languages).");
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.AI_API_KEY;
  else process.env.AI_API_KEY = originalKey;
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
