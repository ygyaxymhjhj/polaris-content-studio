import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
import { chromium } from 'playwright';
const exported = {};
new Function('exports', ts.transpileModule(await fs.readFile('src/lib/normalize-analysis.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exported);
const text = 'A verified excerpt in the source article. '.repeat(10);
const raw = { summaryShort: { invalid: true }, summaryLong: ['bad'], keyTerms: ['Gold', { term: 'Forex' }, 'Gold', null], riskFlags: ['high', { level: 'high', reason: 'Financial claims require review' }, null], facts: [
  { id: 'same', text: 'First fact', sourceExcerpt: 'A verified excerpt in the source article.', sourceLocation: { paragraph: 1 }, riskLevel: 'LOW', verified: true },
  { id: 'same', text: 'Second fact', sourceExcerpt: 'not in source', type: null },
  { id: 'bad', text: { unsupported: 'object' } }
] };
const normalized = exported.normalizeAnalysis(raw, text, 'Test title');
assert.equal(normalized.facts.length, 2);
assert.equal(new Set(normalized.facts.map(f => f.id)).size, 2);
assert(normalized.facts.every(f => !f.verified));
assert(!normalized.facts[1].usableOnSocial);
assert(normalized.riskFlags.every(f => typeof f === 'string'));
assert.deepEqual(normalized.keyTerms, ['Gold', 'Forex']);
assert.throws(() => exported.normalizeAnalysis({ facts: {} }, text, 'Test'));
const chunks = exported.analysisChunks(text.repeat(30));
assert(chunks.length > 1 && chunks.every(c => c.length <= 2200));
assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), text.repeat(30).replace(/\s+/g, ' ').trim());
const browser = await chromium.launch();
try {
 const page = await browser.newPage(); const errors = [];
 page.on('pageerror', e => errors.push(e.message));
 await page.route('**/api/analyze', route => route.fulfill({ json: raw }));
 await page.route('**/api/generate', route => route.fulfill({ json: { assets: [], usedFallback: false } }));
 await page.route('**/api/projects**', r => r.fulfill({json:{enabled:false,projects:[]}}));
 await page.goto(process.env.TEST_BASE_URL || 'http://localhost:3002');
 await page.locator('.locale-switcher select').selectOption('en');
 await page.locator('.source-textarea').fill(text);
 await page.getByRole('button', { name: 'Generate social drafts', exact: true }).click();
 await page.getByRole('button', { name: 'Regenerate', exact: true }).waitFor();
 await page.locator('.nav-item').filter({ hasText: 'Source references' }).click();
 await page.getByRole('button', { name: 'Confirm displayed facts', exact: true }).waitFor();
 assert.equal(await page.locator('.fact-row').count(), 2);
 assert.deepEqual(errors, []);
 console.log('PASS: malformed model fields, duplicate IDs/terms, unmatched excerpts, chunk coverage and client rendering without a white screen.');
} finally { await browser.close(); }
