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
  for (const file of ["types", "asset-specs", "starter-assets", "ai"]) {
    const source = await fs.readFile(`src/lib/${file}.ts`, "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    await fs.writeFile(path.join(temp, `${file}.js`), outputText);
  }
  const require = createRequire(import.meta.url);
  const { starterAssets } = require(path.join(temp, 'starter-assets.js'));
  const { generateWithAI } = require(path.join(temp, 'ai.js'));
  const { ASSET_SPECS } = require(path.join(temp, 'asset-specs.js'));
  const platforms = Object.keys(ASSET_SPECS);
  const config = { name: 'Test', title: 'Source update', category: '', language: 'en', audience: 'Readers', cta: 'Read more', sourceUrl: 'https://example.com/news', websiteUrl: '', tone: '', publishDate: '' };
  const facts = [1, 2, 3].map(n => ({ id: `F00${n}`, text: `Source detail ${n}: the notice states that readers can review the published information and its limitations.`, sourceExcerpt: 'Test', sourceLocation: 'Test', type: 'claim', verified: true, usableOnSocial: true, riskLevel: 'low' }));
  const analysis = { summaryShort: 'Test', summaryLong: 'Test', keyTerms: [], riskFlags: [], facts: [...facts, { ...facts[0], id: 'EXCLUDED', verified: false, text: 'DO_NOT_USE' }] };
  for (const language of ['en', 'zh', 'vi']) {
    const result = starterAssets({ ...config, language }, analysis, platforms);
    assert.equal(result.assets.length, 15);
    assert.equal(new Set(result.assets.map(a => a.id)).size, 15);
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
    assert.deepEqual(result.assets.filter(a => a.platform === 'short_video').map(a => a.meta.duration), ['30s', '60s']);
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
  console.log('PASS: 15 starter assets in 3 languages, complete delivery fields, source filtering, Facebook revision and partial provider fallback. No paid API requests.');
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = originalKey;
  await fs.rm(temp, { recursive: true, force: true });
}
