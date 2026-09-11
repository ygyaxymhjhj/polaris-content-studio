import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "polaris-assets-"));
const originalFetch = globalThis.fetch;
const originalKey = process.env.AI_API_KEY;
try {
  for (const file of ["types", "asset-specs", "context-budget", "social-guidelines", "starter-assets", "ai"]) {
    const source = await fs.readFile(`src/lib/${file}.ts`, "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    await fs.writeFile(path.join(temp, `${file}.js`), outputText);
  }
  const require = createRequire(import.meta.url);
  const { starterAssets } = require(path.join(temp, 'starter-assets.js'));
  const { generateWithAI, rewriteAsset } = require(path.join(temp, 'ai.js'));
  const { ASSET_SPECS } = require(path.join(temp, 'asset-specs.js'));
  const { contextWindowFor, estimateTokens } = require(path.join(temp, 'context-budget.js'));
  const platforms = Object.keys(ASSET_SPECS);
  const config = { name: 'Test', title: 'Source update', category: '', language: 'en', audience: 'Readers', cta: 'Read more', sourceUrl: 'https://example.com/news', websiteUrl: '', tone: '', publishDate: '' };
  const facts = [1, 2, 3].map(n => ({ id: `F00${n}`, text: `Source detail ${n}: the notice states that readers can review the published information and its limitations.`, sourceExcerpt: 'Test', sourceLocation: 'Test', type: 'claim', verified: true, usableOnSocial: true, riskLevel: 'low' }));
  const analysis = { summaryShort: 'Test', summaryLong: 'Test', keyTerms: [], riskFlags: [], facts: [...facts, { ...facts[0], id: 'EXCLUDED', verified: false, text: 'DO_NOT_USE' }] };
  for (const language of ['en', 'zh', 'vi']) {
    const result = starterAssets({ ...config, language }, analysis, platforms);
    assert.equal(result.assets.length, 14);
    assert.equal(new Set(result.assets.map(a => a.id)).size, 14);
    for (const asset of result.assets) {
      assert(asset.content.length > 0);
      assert(!JSON.stringify(asset).includes('DO_NOT_USE'));
      assert(!asset.factIds.includes('EXCLUDED'));
      assert.equal(asset.generationMode, 'local');
      for (const key of ASSET_SPECS[asset.platform].notes) assert(key in asset.meta, `${asset.platform}: ${key}`);
    }
    const fb = result.assets.filter(a => a.platform === 'facebook');
    assert.notEqual(fb[0].content, fb[1].content);
    assert(fb[0].content.includes(config.sourceUrl));
    assert(!fb[0].content.includes(fb[0].meta.visualBrief));
    assert.deepEqual(result.assets.filter(a => a.platform === 'short_video').map(a => a.meta.duration), ['40-70s']);
  }
  process.env.AI_API_KEY = 'test-only';
  const calls = {};
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const prompt = request.messages[1].content;
    const platform = prompt.match(/for (\w+) ONLY/)[1];
    calls[platform] = (calls[platform] || 0) + 1;
    assert(!prompt.includes('DO_NOT_USE'));
    if (platform === 'push') return new Response('unavailable', { status: 503 });
    const assets = starterAssets(config, analysis, [platform]).assets;
    if (platform === 'facebook' && calls[platform] === 1) assets.forEach(a => { a.content = 'Too short'; a.meta = {}; });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ assets }) } }] });
  };
  const result = await generateWithAI(config, analysis, ['facebook', 'push']);
  assert.equal(calls.facebook, 2, 'Incomplete Facebook draft should be revised once');
  assert.equal(result.assets.length, 5);
  assert(result.assets.filter(a => a.platform === 'facebook').every(a => a.generationMode === 'ai' && a.content.length > 350));
  assert(result.assets.filter(a => a.platform === 'push').every(a => a.generationMode === 'local'));
  assert(result.usedFallback);

  // Platform voice rules follow the copy language, and no channel overrides it.
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const platform = request.messages[1].content.match(/for (\w+) ONLY/)[1];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ assets: starterAssets(config, analysis, [platform]).assets }) } }] });
  };
  await generateWithAI({ ...config, language: 'vi' }, analysis, ['facebook', 'linkedin', 'website']);
  const promptFor = platform => requests.find(request => request.messages[1].content.includes(`for ${platform} ONLY`));
  const facebookPrompt = promptFor('facebook');
  const linkedinPrompt = promptFor('linkedin');
  // Every channel writes in config.language; no channel overrides it.
  for (const platform of ['facebook', 'linkedin', 'website']) {
    const prompt = promptFor(platform).messages[1].content;
    assert.equal(/must use language (\w+)/.exec(prompt)[1], 'vi', `${platform} writes in config.language`);
    assert(prompt.includes('"language":"vi"'), `${platform} project context matches config.language`);
  }
  assert(facebookPrompt.messages[0].content.includes('Không biến mọi caption thành quảng cáo'), 'Vietnamese global rules go into the system prompt');
  assert(facebookPrompt.messages[1].content.includes('Mỗi caption đều phải có icon/emoji'), 'Vietnamese platform rules follow the project language');
  assert(linkedinPrompt.messages[1].content.includes('Nội dung phải được viết bằng ngôn ngữ đầu ra'), 'LinkedIn voice rules follow the project language');
  assert(!linkedinPrompt.messages[1].content.includes('100% bằng tiếng Anh'), 'No channel forces a language other than config.language');
  assert(!linkedinPrompt.messages[0].content.includes('Write natural, readable English'), 'LinkedIn receives Vietnamese global rules like every other channel');
  assert(!promptFor('website').messages[1].content.includes('PLATFORM VOICE RULES'), 'Platforms without voice rules keep the format brief only');

  // Context budget: model windows, a conservative estimate, and the environment override.
  assert.equal(contextWindowFor('google/gemini-3.8-flash'), 1048576, 'Known model families are looked up');
  assert.equal(contextWindowFor('gpt-4o-mini'), 128000);
  assert.equal(contextWindowFor('some-unlisted-model'), 128000, 'Unknown models fall back to the default window');
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('中文字符'), 4, 'Wide characters count as one token each');
  process.env.AI_MAX_CONTEXT = '3000';
  assert.equal(contextWindowFor('google/gemini-3.8-flash'), 3000, 'AI_MAX_CONTEXT overrides the table');

  // Rewrite: replaces the asset in place, keeps the summary, strips revisions and trims history.
  const longCopy = 'The regulator set out clearer disclosure duties for platforms serving retail traders, covering fees, order execution and withdrawal conditions. '.repeat(3);
  const baseAsset = { id: 'ai-facebook-1', platform: 'facebook', assetType: 'short_post', title: 'Original title', content: longCopy, cta: 'Read the full article', factIds: ['F001'], riskFlags: [], status: 'needs_review', meta: { visualBrief: 'Neutral fact card', imageText: 'Regulator update', firstComment: 'Details in the article' }, updatedAt: '2026-01-01T00:00:00.000Z' };
  const turns = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `第 ${index} 轮：这一段改写得更口语一些，同时保留全部数字与日期。`, at: '2026-01-01T00:00:00.000Z' }));
  const rewriteRequests = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    rewriteRequests.push(request);
    const revised = { ...baseAsset, content: longCopy.replace('regulator', 'watchdog'), changeSummary: '压到 268 字符，保留日期与费率' };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [revised, { ...revised, title: 'Second angle', changeSummary: '换个开头角度' }] }) } }] });
  };
  const withHistory = { ...baseAsset, revisions: [{ at: '2026-01-01T00:00:00.000Z', instruction: 'earlier', before: { title: 't', content: 'c', factIds: [] } }] };
  const rewrite = await rewriteAsset({ ...config, language: 'zh' }, analysis, withHistory, turns, '再短一点', 2);
  const rewriteRequest = rewriteRequests[0];
  assert.equal(rewrite.candidates.length, 2, 'Both candidates survive normalisation');
  assert.equal(rewrite.candidates[0].asset.id, baseAsset.id, 'A revision replaces the asset in place');
  assert.equal(rewrite.candidates[0].changeSummary, '压到 268 字符，保留日期与费率');
  assert.equal(rewrite.candidates[0].asset.revisions, undefined, 'Revisions are added on adopt, never by the model');
  assert.deepEqual(rewrite.candidates[0].issues, [], 'A compliant revision reports no issues');
  assert(rewrite.droppedTurns > 0, 'A long conversation is trimmed to fit the window');
  assert(rewriteRequest.messages[1].content.includes('older turn(s) were dropped'), 'The model is told the history was trimmed');
  assert(rewriteRequest.messages[1].content.includes('CURRENT DRAFT'), 'The current draft is always sent as structured input');
  assert(rewriteRequest.messages[1].content.includes('REVISION REQUEST:\n再短一点'));
  assert(rewriteRequest.messages[0].content.includes('This is a revision task, not a rewrite'));
  assert(rewriteRequest.messages[0].content.includes('WRITING PRINCIPLES'));
  // Normalisation drops every candidate that does not echo the platform, so both the draft and the
  // instruction have to name it. Omitting it silently rejects the whole reply.
  assert(rewriteRequest.messages[1].content.includes('"platform": "facebook"'), 'The draft identifies its platform');
  assert(rewriteRequest.messages[1].content.includes('platform="facebook"'), 'The instruction pins the platform literally');
  // Reasoning models scale their thinking to the cap they are given, so capping the reply starves
  // it: the JSON is cut off mid-string and parses as "the model returned nothing".
  assert.equal(rewriteRequest.max_tokens, undefined, 'The reply is left uncapped so thinking cannot starve it');
  process.env.AI_MAX_OUTPUT_TOKENS = '4000';
  await rewriteAsset({ ...config, language: 'zh' }, analysis, baseAsset, [], '再短一点', 1);
  assert.equal(rewriteRequests.at(-1).max_tokens, 4000, 'AI_MAX_OUTPUT_TOKENS restores an explicit cap on request');
  delete process.env.AI_MAX_OUTPUT_TOKENS;

  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [{ ...baseAsset, platform: undefined, changeSummary: 'x' }] }) } }] });
  const unusable = await rewriteAsset({ ...config, language: 'zh' }, analysis, baseAsset, [], '再短一点', 1);
  assert.equal(unusable.candidates.length, 0, 'A candidate that does not echo the platform is dropped');
  assert.equal(unusable.rejected, 1, 'Dropped options are counted so the failure can be explained');

  // A complete reply is never retried just because the format minimum is unmet: a revision keeps
  // the draft as it stands, so that check can never be satisfied by asking again. Retrying it used
  // to double the latency and cost of every single rewrite.
  rewriteRequests.length = 0;
  globalThis.fetch = async (_url, options) => {
    rewriteRequests.push(JSON.parse(options.body));
    const brief = { ...baseAsset, content: 'Too brief for the format.', changeSummary: 'x' };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [brief, { ...brief, title: 'Second angle' }] }) } }] });
  };
  const flagged = await rewriteAsset({ ...config, language: 'zh' }, analysis, baseAsset, [], '再短一点', 2);
  assert.equal(rewriteRequests.length, 1, 'A complete reply is not retried for being brief');
  assert.equal(flagged.candidates.length, 2);
  assert(flagged.candidates[0].issues.length > 0, 'Content issues still ride along for the reviewer to judge');
  delete process.env.AI_MAX_CONTEXT;

  console.log('PASS: 14 starter assets in 3 languages, delivery fields, source filtering, Facebook revision, provider fallback, config.language-driven voice rules, model-aware context trimming and grounded single-asset rewriting. No paid API requests.');
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = originalKey;
  await fs.rm(temp, { recursive: true, force: true });
}
