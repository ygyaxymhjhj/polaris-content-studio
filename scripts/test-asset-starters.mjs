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
  for (const file of ["types", "asset-specs", "context-budget", "source-config", "social-guidelines", "normalize-analysis", "starter-assets", "ai"]) {
    const source = await fs.readFile(`src/lib/${file}.ts`, "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
    await fs.writeFile(path.join(temp, `${file}.js`), outputText);
  }
  const require = createRequire(import.meta.url);
  const { starterAssets } = require(path.join(temp, 'starter-assets.js'));
  const { generateWithAI, rewriteAsset, askModel } = require(path.join(temp, 'ai.js'));
  const { normalizeAnalysis, mergeChunkAnalyses } = require(path.join(temp, 'normalize-analysis.js'));
  const { ASSET_SPECS, ASSET_TYPES, assetQualityIssues } = require(path.join(temp, 'asset-specs.js'));
  const { detectSourceLanguage, dominantSourceLanguage, alignSourceConfig } = require(path.join(temp, 'source-config.js'));
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
      assert.equal(asset.assetType, ASSET_TYPES[asset.platform], `${asset.platform}: offline template and canonical asset types stay in sync`);
    }
    const fb = result.assets.filter(a => a.platform === 'facebook');
    assert.notEqual(fb[0].content, fb[1].content);
    assert(fb[0].content.includes(config.sourceUrl));
    assert(!fb[0].content.includes(fb[0].meta.visualBrief));
    assert.deepEqual(result.assets.filter(a => a.platform === 'short_video').map(a => a.meta.duration), ['40-70s']);
    const video = result.assets.filter(a => a.platform === 'short_video')[0];
    assert(video.assetType === 'voiceover_copy' && video.content.includes('Source detail 1'), 'Short video delivers spoken copy, not a production script');
    assert(!video.content.includes('0–3s') && !video.content.includes('Narration') && !video.content.includes('On-screen text'), 'No timestamps or shot scaffolding leak into the voiceover copy');
    assert(video.riskFlags.some(flag => flag.includes('not spoken-style copy') || flag.includes('未做口语化') || flag.includes('chưa chuyển thành văn nói')), 'The offline voiceover draft says the narration is raw excerpts needing oralization');
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

  // "Prompt Social.md" fixes LinkedIn to English; every other channel follows the project language.
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
  // Channels without a fixed language keep writing in config.language.
  for (const platform of ['facebook', 'website']) {
    const prompt = promptFor(platform).messages[1].content;
    assert.equal(/must use language (\w+)/.exec(prompt)[1], 'vi', `${platform} writes in config.language`);
    assert(prompt.includes('"language":"vi"'), `${platform} project context matches config.language`);
  }
  assert(facebookPrompt.messages[0].content.includes('Không biến mọi caption thành quảng cáo'), 'Vietnamese global rules go into the system prompt');
  assert(facebookPrompt.messages[1].content.includes('Mỗi caption đều phải có icon/emoji'), 'Vietnamese platform rules follow the project language');
  // Facebook opens on an attention hook and leads with a striking figure when the article has one, but
  // must not force one in. The prompt is the only place the model learns that, so pin it per language.
  assert(facebookPrompt.messages[1].content.includes('Câu mở đầu là hook'), 'Vietnamese Facebook rules demand an attention hook in the first line');
  assert(facebookPrompt.messages[1].content.includes('không gượng ép thêm số liệu'), 'Vietnamese Facebook rules forbid forcing a figure in');
  assert(facebookPrompt.messages[1].content.includes('Each content must open with a hook'), 'The Facebook format brief carries the hook requirement as well');
  // LinkedIn publishes in English whatever the brief language, so every part of its prompt has to
  // agree: the instruction, the global principles, the voice rules and the project context.
  assert.equal(/must use language (\w+)/.exec(linkedinPrompt.messages[1].content)[1], 'en', 'LinkedIn writes in English even when the brief is Vietnamese');
  assert(linkedinPrompt.messages[1].content.includes('"language":"en"'), 'LinkedIn project context reports the resolved language');
  assert(linkedinPrompt.messages[1].content.includes('Write 100% of the copy in English'), 'LinkedIn gets the English-only platform rules');
  assert(linkedinPrompt.messages[1].content.includes('never translate a draft sentence by sentence'), 'LinkedIn is told to write English directly, not to translate');
  assert(linkedinPrompt.messages[0].content.includes('Write natural, readable English'), 'LinkedIn global rules match the output language');
  assert(!linkedinPrompt.messages[0].content.includes('Viết tiếng Việt tự nhiên'), 'No Vietnamese writing principles reach the LinkedIn prompt');
  assert(!linkedinPrompt.messages[1].content.includes('ngôn ngữ đầu ra đã cấu hình'), 'The rule that made LinkedIn follow config.language is gone');
  assert(!promptFor('website').messages[1].content.includes('PLATFORM VOICE RULES'), 'Platforms without voice rules keep the format brief only');
  // Models otherwise mislabel the channel ("tiktok" for short_video) and every reply is dropped, so
  // the prompt pins the exact internal key, and the canonical asset type overrides any model guess.
  assert(linkedinPrompt.messages[1].content.includes('platform="linkedin" exactly'), 'The prompt pins the exact platform key');
  requests.length = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const platform = request.messages[1].content.match(/for (\w+) ONLY/)[1];
    const mislabelled = { ...starterAssets(config, analysis, [platform]).assets[0], assetType: 'the_model_guessed_wrong' };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ assets: [mislabelled] }) } }] });
  };
  const typed = await generateWithAI(config, analysis, ['short_video', 'instagram']);
  assert.equal(typed.assets.find(asset => asset.platform === 'short_video').assetType, 'voiceover_copy', 'The model cannot rename an internal asset type');
  assert.equal(typed.assets.find(asset => asset.platform === 'instagram').assetType, 'carousel', 'Every platform keeps its canonical asset type');
  requests.length = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const spoken = 'Spoken copy that lasts forty seconds of narration time and is long enough to pass the minimum length check without a retry. '.repeat(3);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ assets: [{ platform: 'tiktok', content: spoken, meta: { duration: '40-70s', caption: 'One line #gold' }, factIds: ['F001'], title: 'T' }] }) } }] });
  };
  const aliased = await generateWithAI(config, analysis, ['short_video']);
  assert.equal(aliased.assets.find(asset => asset.platform === 'short_video').assetType, 'voiceover_copy', 'A "tiktok" reply is accepted as short_video without a retry');
  // The editor's actual first step: importing Vietnamese text decides the project language, and that
  // decision must not reach the LinkedIn prompt. Everything above set language explicitly, so without
  // this the imported-project case — the one that was reported — would never be exercised.
  const emptyConfig = { name: '', title: '', category: '', language: 'en', audience: '', cta: '', websiteUrl: '', sourceUrl: '', tone: '', publishDate: '' };
  const imported = alignSourceConfig(emptyConfig, { text: 'Giá vàng giao ngay tăng 1,4% sau khi Fed công bố giữ nguyên lãi suất.', sourceUrl: 'https://example.com/gold' }, new Set());
  assert.equal(imported.language, 'vi', 'Importing Vietnamese source text decides the project language');
  requests.length = 0;
  await generateWithAI(imported, analysis, ['linkedin', 'facebook']);
  assert.equal(/must use language (\w+)/.exec(promptFor('linkedin').messages[1].content)[1], 'en', 'An imported Vietnamese article still gets an English LinkedIn prompt');
  assert.equal(/must use language (\w+)/.exec(promptFor('facebook').messages[1].content)[1], 'vi', 'The same import keeps the other channels in the imported language');
  // Asking for a fast-news tone made models open Chinese posts with a 【快讯】 column header, so the
  // X rules now say explicitly that the style name is not a label to print.
  requests.length = 0;
  await generateWithAI({ ...config, language: 'zh' }, analysis, ['x', 'facebook']);
  const zhFor = platform => requests.find(request => request.messages[1].content.includes(`for ${platform} ONLY`));
  assert(zhFor('x').messages[1].content.includes('不要把「快讯」「突发」这类栏目标签写进文案开头'), 'The Chinese X rules forbid printing the style label');
  assert(zhFor('facebook').messages[1].content.includes('首句是钩子'), 'The Chinese Facebook rules demand an attention hook in the first line');
  assert(zhFor('facebook').messages[1].content.includes('也不要为了显得有力硬塞数据'), 'The Chinese Facebook rules forbid forcing a figure in');
  requests.length = 0;
  await generateWithAI({ ...config, language: 'en' }, analysis, ['facebook']);
  assert(requests[0].messages[1].content.includes('The opening sentence is the hook'), 'The English Facebook rules demand an attention hook in the first line');
  assert(requests[0].messages[1].content.includes('never force one in'), 'The English Facebook rules forbid forcing a figure in');
  requests.length = 0;
  await generateWithAI({ ...config, language: 'vi' }, analysis, ['x']);
  assert(requests[0].messages[1].content.includes('không mở đầu bằng nhãn mục'), 'The Vietnamese X rules forbid printing the style label');

  // The offline template quotes source text verbatim and cannot translate it, so a LinkedIn draft
  // built from Vietnamese text is framed in English and carries an explicit warning instead of
  // pretending to be publishable English copy.
  const vietnameseFacts = facts.map((fact, index) => ({ ...fact, text: `Chi tiết ${index + 1}: thông báo nêu rõ người đọc có thể xem lại thông tin đã công bố và các giới hạn kèm theo.` }));
  const vietnameseAnalysis = { ...analysis, facts: vietnameseFacts };
  const offlineLinkedin = starterAssets({ ...config, language: 'vi' }, vietnameseAnalysis, ['linkedin']).assets[0];
  assert(offlineLinkedin.content.includes('What the source says'), 'The offline LinkedIn frame is English, not the project language');
  assert.equal(offlineLinkedin.content.includes('Thông tin từ bài viết'), false, 'No Vietnamese frame reaches a LinkedIn offline draft');
  assert(offlineLinkedin.riskFlags.some(flag => flag.includes('cannot translate')), 'The offline LinkedIn draft warns that its quoted source is not English');
  assert(offlineLinkedin.content.includes('Chi tiết 1'), 'Quoted source text is still copied verbatim, as the offline template documents');
  const offlineFacebook = starterAssets({ ...config, language: 'vi' }, vietnameseAnalysis, ['facebook']).assets[0];
  assert(offlineFacebook.content.includes('Thông tin từ bài viết'), 'Channels without a fixed language keep the project language offline');
  // The offline X draft used the source title verbatim, so a 财经快讯 column headline opened the post
  // with the column's own name; the template now strips those labels and falls back to the title.
  const columnTitled = starterAssets({ ...config, language: 'zh', title: '财经快讯：金价上涨' }, analysis, ['x']).assets[0];
  assert.equal(columnTitled.content.startsWith('财经快讯'), false, 'The offline X draft strips the source column label');
  assert(columnTitled.content.startsWith('金价上涨'), 'The offline X draft opens with the headline, not the column name');
  const labelled = starterAssets({ ...config, language: 'zh', title: '快讯' }, analysis, ['x']).assets[0];
  assert(labelled.content.startsWith('快讯\n'), 'A title that is only a column label keeps a usable opening');
  // The strip happens once, before any channel template runs, so every offline channel benefits.
  const columnFacebook = starterAssets({ ...config, language: 'zh', title: '财经快讯：金价上涨' }, analysis, ['facebook']).assets[0];
  assert.equal(columnFacebook.content.startsWith('财经快讯'), false, 'Every offline channel strips the column label, not only X');
  const columnVi = starterAssets({ ...config, language: 'vi', title: 'Bản tin tài chính：Vàng tăng' }, analysis, ['x']).assets[0];
  assert(columnVi.content.startsWith('Vàng tăng'), 'A multi-word Vietnamese column label is stripped whole');
  const columnWebsite = starterAssets({ ...config, language: 'zh', title: '财经快讯：金价上涨' }, analysis, ['website']).assets[0];
  assert(!columnWebsite.content.startsWith('# 财经快讯'), 'The website draft heading drops the column label');
  assert.equal(columnWebsite.meta.seoTitle, '财经快讯：金价上涨', 'The SEO title keeps the full source headline');
  // The warning follows the text, not the channel policy: choosing English for a Vietnamese article
  // still leaves excerpt text that has to be rewritten, and matching channel and project language
  // must not silence that.
  const englishProjectLinkedin = starterAssets({ ...config, language: 'en' }, vietnameseAnalysis, ['linkedin']).assets[0];
  assert(englishProjectLinkedin.riskFlags.some(flag => flag.includes('cannot translate')), 'A Vietnamese excerpt is warned about even when the project language is English');
  const englishProjectEnglishFacts = starterAssets({ ...config, language: 'en' }, analysis, ['linkedin']).assets[0];
  assert(!englishProjectEnglishFacts.riskFlags.some(flag => flag.includes('cannot translate')), 'English source text under an English project raises no language warning');
  // A Vietnamese title or CTA inside an English draft has to be caught on its own: measuring it
  // together with the quoted text dilutes it away and the draft looks ready to publish.
  const vietnameseCta = starterAssets({ ...config, language: 'vi', cta: 'Đọc toàn bộ bài viết' }, analysis, ['linkedin']).assets[0];
  assert(vietnameseCta.riskFlags.some(flag => flag.includes('the call to action')), 'A Vietnamese CTA is named even when the quoted facts are English');
  const vietnameseTitle = starterAssets({ ...config, language: 'en', title: 'Giá vàng tăng sau quyết định của Fed' }, analysis, ['linkedin']).assets[0];
  assert(vietnameseTitle.riskFlags.some(flag => flag.includes('the title')), 'A Vietnamese title is named even when the quoted facts are English');
  assert(vietnameseTitle.riskFlags.every(flag => !flag.includes('the quoted facts')), 'Only the fields that actually mismatched are named');
  // The wording separates a channel that fixes its language from a project setting, which was the
  // whole point of the LinkedIn fix: Facebook publishes in Vietnamese because the project says so.
  assert(offlineLinkedin.riskFlags.some(flag => flag.includes('LinkedIn publishes in en only')), 'A fixed channel is described by its own publishing rule');
  const offlineFacebookEnglishSource = starterAssets({ ...config, language: 'vi' }, analysis, ['facebook']).assets[0];
  const facebookLanguageFlag = offlineFacebookEnglishSource.riskFlags.find(flag => flag.includes('cannot translate'));
  assert(facebookLanguageFlag && facebookLanguageFlag.includes('The project output language is vi'), 'Other channels are described by the project setting, not as a publishing rule');

  // Language detection: the import path stays signal-based, the draft path weighs the whole text.
  assert.equal(detectSourceLanguage({ text: 'Giá vàng tăng sau quyết định lãi suất.' }), 'vi', 'Vietnamese imports are detected');
  assert.equal(detectSourceLanguage({ text: '金价在美联储决定后上涨。' }), 'zh', 'Chinese imports are detected');
  assert.equal(detectSourceLanguage({ text: 'Gold prices rose after the Fed decision.' }), 'en', 'English imports are detected');
  assert.equal(detectSourceLanguage({ text: 'Gold prices rose.', sourceUrl: 'https://example.com/vi/news' }), 'vi', 'A Vietnamese URL path still decides the import language');
  assert.equal(dominantSourceLanguage('Chi tiết 1: thông báo nêu rõ người đọc có thể xem lại thông tin đã công bố và các giới hạn kèm theo.'), 'vi');
  assert.equal(dominantSourceLanguage('金价在美联储决定后上涨，市场关注后续政策指引。'), 'zh');
  assert.equal(dominantSourceLanguage('Gold prices rose 1.4% to $2,418 per ounce after the Fed held rates steady.'), 'en');
  assert.equal(dominantSourceLanguage('Nguyễn Văn A, a strategist at Ngân hàng Nhà nước, said the Fed decision changes how retail platforms publish fees and withdrawal terms.'), 'en', 'A quotation or a name does not make an English draft Vietnamese');
  assert.equal(dominantSourceLanguage('金价上涨，Nguyễn Văn A 表示市场关注美联储的决定。'), 'zh', 'A Vietnamese name does not flip a Chinese draft to Vietnamese');
  // Import-chain behaviours that outdate nothing here but were never pinned: alignSourceConfig is what
  // writes config.language, and the detector reads the title as well as the body.
  assert.equal(alignSourceConfig(emptyConfig, { text: '金价在美联储决定后上涨。' }, new Set()).language, 'zh', 'Importing Chinese source text decides the project language');
  assert.equal(alignSourceConfig(emptyConfig, { text: 'Gold prices rose after the Fed decision.' }, new Set()).language, 'en', 'Importing English source text keeps the project in English');
  assert.equal(alignSourceConfig({ ...emptyConfig, language: 'en' }, { text: 'Giá vàng tăng.' }, new Set(['language'])).language, 'en', 'A language the editor chose survives the next import');
  assert.equal(alignSourceConfig(emptyConfig, { text: 'Giá vàng tăng.' }, new Set()).cta, 'Đọc toàn bộ bài viết', 'The imported project gets defaults in its own language');
  assert.equal(detectSourceLanguage({ title: 'Giá vàng tăng', text: 'Gold prices rose after the Fed decision.' }), 'vi', 'A Vietnamese title alone classifies an import as Vietnamese, as the detector reads the title too');

  // The online path reports the same language mismatch the offline path warns about, and the
  // generation retry reuses the issue, so a provider that ignores the channel cannot pass silently.
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const platform = request.messages[1].content.match(/for (\w+) ONLY/)[1];
    const assets = starterAssets(config, analysis, [platform]).assets.map(asset => platform === 'linkedin'
      ? { ...asset, content: 'Giá vàng giao ngay tăng 1,4% lên 2.418 USD/ounce sau khi Fed công bố giữ nguyên lãi suất, và thị trường phản ứng ngay sau cuộc họp báo kéo dài ba mươi phút.' }
      : asset);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ assets }) } }] });
  };
  const ignored = await generateWithAI({ ...config, language: 'vi' }, analysis, ['linkedin']);
  const refused = ignored.assets.find(asset => asset.platform === 'linkedin');
  assert(refused.riskFlags.some(flag => flag.includes('publishes in en')), 'A LinkedIn draft that came back in Vietnamese is reported, not accepted silently');
  assert(refused.generationMode === 'ai', 'The flagged draft is the provider reply, not a substituted local template');
  // Assert on the language issue itself: these fixtures are far below the LinkedIn length minimum,
  // so a bare length check would fail for an unrelated reason and point at the wrong code.
  assert(!assetQualityIssues({ ...refused, content: 'Gold prices rose after the Fed held rates steady, and the market reacted within minutes of the briefing.' }, 'vi').some(issue => issue.includes('publishes in')), 'English LinkedIn copy passes the language check');
  assert(!assetQualityIssues({ ...refused, content: 'Gold prices rose after the Fed held rates steady.' }, 'en').some(issue => issue.includes('publishes in')), 'The check does not fire when the channel follows the project language');
  // Matching channel and project language must not hide the mismatch either: an English project that
  // still receives Vietnamese LinkedIn copy is exactly the reported symptom.
  const englishProjectReply = await generateWithAI({ ...config, language: 'en' }, analysis, ['linkedin']);
  assert(englishProjectReply.assets[0].riskFlags.some(flag => flag.includes('publishes in en')), 'Vietnamese copy is reported even when the project language is already English');
  // The gate is for the channel whose language the project cannot change. A draft from before a
  // language switch must not start flagging every asset on channels that follow config.language.
  assert(!assetQualityIssues({ ...refused, platform: 'facebook', content: 'Giá vàng giao ngay tăng 1,4% sau khi Fed công bố giữ nguyên lãi suất, và thị trường phản ứng ngay sau cuộc họp báo.' }, 'en').some(issue => issue.includes('publishes in')), 'Channels that follow the project language are not language-flagged');

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

  // A draft saved before the channel language was fixed is still in the brief language. REWRITE_SYSTEM
  // forbids touching sentences the request does not mention, so the conversion has to be spelled out
  // or the model silently translates the whole post without the editor asking for it.
  rewriteRequests.length = 0;
  globalThis.fetch = async (_url, options) => {
    rewriteRequests.push(JSON.parse(options.body));
    const converted = { ...baseAsset, platform: 'linkedin', content: longCopy, changeSummary: 'Converted the draft to English' };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [converted] }) } }] });
  };
  const vietnameseDraft = { ...baseAsset, platform: 'linkedin', content: 'Cơ quan quản lý đã nêu rõ nghĩa vụ công bố thông tin cho các nền tảng phục vụ nhà đầu tư cá nhân, bao gồm phí giao dịch, khớp lệnh và điều kiện rút tiền.' };
  await rewriteAsset({ ...config, language: 'vi' }, analysis, vietnameseDraft, [], 'ngắn hơn một chút', 1);
  const linkedinRewrite = rewriteRequests[0].messages[1].content;
  assert.equal(/must use language (\w+)/.exec(linkedinRewrite)[1], 'en', 'A LinkedIn revision writes in English even when the draft and brief are Vietnamese');
  assert(linkedinRewrite.includes('"language":"en"'), 'The LinkedIn revision reports the resolved language in its project context');
  assert(linkedinRewrite.includes('The current draft is written in vi'), 'The revision names the draft language it detected');
  assert(linkedinRewrite.includes('convert the whole draft to en'), 'Converting the draft is an explicit instruction, not a silent translation');
  assert(rewriteRequests[0].messages[0].content.includes('Write natural, readable English'), 'LinkedIn revision principles match the output language');
  // The detector answers "is there any signal", so an English draft that merely names Vietnamese
  // people or institutions must not be read as a Vietnamese draft and rewritten end to end.
  rewriteRequests.length = 0;
  const englishWithVietnameseNames = 'Nguyễn Văn A, a strategist at Ngân hàng Nhà nước, said the new disclosure duty changes how retail platforms in Việt Nam publish fees, order execution and withdrawal terms.';
  await rewriteAsset({ ...config, language: 'vi' }, analysis, { ...baseAsset, platform: 'linkedin', content: englishWithVietnameseNames }, [], 'ngắn hơn một chút', 1);
  const namedRewrite = rewriteRequests[0].messages[1].content;
  assert.equal(/must use language (\w+)/.exec(namedRewrite)[1], 'en');
  assert(!namedRewrite.includes('The current draft is written in'), 'An English draft naming Vietnamese entities is not treated as a foreign draft');
  assert(!namedRewrite.includes('convert the whole draft to'), 'No whole-draft conversion is requested for a draft already in the channel language');
  // Every channel has to produce copy in the language the prompt asks for, so a draft in another
  // language is converted explicitly rather than left alone while the prompt demands the other one.
  rewriteRequests.length = 0;
  await rewriteAsset({ ...config, language: 'vi' }, analysis, baseAsset, [], 'ngắn hơn một chút', 1);
  assert(rewriteRequests[0].messages[1].content.includes('convert the whole draft to vi'), 'A mismatch on any channel is converted explicitly instead of leaving the prompt self-contradictory');
  // A mismatch can also come from a project language the editor changed after the draft was written,
  // so the draft language is read from the text rather than inferred from the channel policy.
  rewriteRequests.length = 0;
  await rewriteAsset({ ...config, language: 'en' }, analysis, vietnameseDraft, [], 'shorten it', 1);
  const englishProjectRewrite = rewriteRequests[0].messages[1].content;
  assert(englishProjectRewrite.includes('convert the whole draft to en'), 'An English project still converts a Vietnamese LinkedIn draft');
  assert.equal(/must use language (\w+)/.exec(englishProjectRewrite)[1], 'en');
  rewriteRequests.length = 0;
  await rewriteAsset({ ...config, language: 'vi' }, analysis, { ...baseAsset, content: 'Giá vàng giao ngay tăng 1,4% sau khi Fed công bố giữ nguyên lãi suất, và thị trường phản ứng ngay sau cuộc họp báo kéo dài ba mươi phút.' }, [], 'ngắn hơn một chút', 1);
  assert(!rewriteRequests[0].messages[1].content.includes('convert the whole draft to'), 'A draft already in the requested language is left alone');

  // Provider outages used to kill a whole analyze run: the last segment died to an upstream error
  // envelope (HTTP 200, finishReason "error") and every earlier segment was thrown away with it.
  // askModel now retries fast transient failures, and analyze keeps whichever segments succeeded.
  let transientAttempts = 0;
  globalThis.fetch = async () => {
    transientAttempts += 1;
    if (transientAttempts === 1) return new Response('upstream unavailable', { status: 503 });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] });
  };
  const retried = await askModel('system', 'prompt');
  assert.equal(transientAttempts, 2, 'A provider 503 is retried inside askModel');
  assert.deepEqual(retried, { ok: true }, 'The retry returns the provider reply once it succeeds');

  let envelopeAttempts = 0;
  globalThis.fetch = async () => {
    envelopeAttempts += 1;
    if (envelopeAttempts === 1) return Response.json({ choices: [{ finish_reason: 'error', message: { content: '{"summaryShort": "BOJ na' } }], usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] });
  };
  const enveloped = await askModel('system', 'prompt');
  assert.equal(envelopeAttempts, 2, 'An upstream-error envelope is read as a transient provider failure and retried');
  assert.deepEqual(enveloped, { ok: true });

  let authAttempts = 0;
  globalThis.fetch = async () => { authAttempts += 1; return new Response('unauthorized', { status: 401 }); };
  await assert.rejects(askModel('system', 'prompt'), /401/, 'Auth failures are deterministic and never retried');
  assert.equal(authAttempts, 1, 'A 401 makes exactly one provider call');

  let outageAttempts = 0;
  globalThis.fetch = async () => { outageAttempts += 1; return new Response('down', { status: 503 }); };
  await assert.rejects(askModel('system', 'prompt'), /AI provider unavailable after 3 attempts/, 'Transient failures stop after the initial call plus two retries');
  assert.equal(outageAttempts, 3, 'The retry budget is bounded');

  // Partial analyze degradation: one lost segment becomes a coverage warning on the merged analysis
  // instead of a 502, and a run where every segment failed still fails loudly.
  const segmentArticle = 'Fact A about the notice.\n\nFact B about the notice.';
  const segmentA = normalizeAnalysis({ summaryShort: 'A', summaryLong: 'Long A', keyTerms: ['k'], riskFlags: [], facts: [{ id: 'x', type: 'claim', text: 'Fact A about the notice.', sourceExcerpt: 'Fact A about the notice.', sourceLocation: 'p1', verified: false, usableOnSocial: true, riskLevel: 'low' }] }, segmentArticle, 'T');
  const merged = mergeChunkAnalyses([segmentA], [{ location: '2', reason: 'AI provider unavailable after 3 attempts: provider returned 503' }], segmentArticle, 'T');
  assert.equal(merged.facts.length, 1, 'Facts from the segments that did analyze survive');
  assert(merged.riskFlags.some(flag => flag.includes('Segment 2 could not be analyzed') && flag.includes('NOT covered')), 'A skipped segment is reported as a coverage hole where the reviewer reads');
  assert.throws(() => mergeChunkAnalyses([], [{ location: '1', reason: 'provider returned 503' }], segmentArticle, 'T'), /Analysis failed for all segments/, 'A run where every segment failed still throws');

  // askModel owns provider-side retries now. The generation and rewrite loops must not stack a
  // second retry budget on top: worst case that turned one outage into six sequential calls.
  let generationOutageCalls = 0;
  globalThis.fetch = async () => { generationOutageCalls += 1; return new Response('down', { status: 503 }); };
  const outaged = await generateWithAI(config, analysis, ['facebook']);
  assert.equal(generationOutageCalls, 3, 'A generation outage runs the askModel retry budget once, with no second outer round');
  assert(outaged.usedFallback && outaged.assets.every(asset => asset.generationMode === 'local'), 'The outaged channel still completes from the local template');

  let rewriteOutageCalls = 0;
  globalThis.fetch = async () => { rewriteOutageCalls += 1; return new Response('down', { status: 503 }); };
  const rewriteOutage = await rewriteAsset(config, analysis, baseAsset, [], 'shorten it', 2);
  assert.equal(rewriteOutageCalls, 3, 'A rewrite outage also stops at the askModel budget');
  assert.equal(rewriteOutage.candidates.length, 0);
  assert(rewriteOutage.reason?.includes('unavailable after 3 attempts'), 'The failure reason names the exhausted retry budget');

  // A malformed model reply is an output problem, not a provider outage, so the generation loop
  // still earns its one extra attempt.
  let malformedCalls = 0;
  globalThis.fetch = async (_url, options) => {
    malformedCalls += 1;
    const platform = JSON.parse(options.body).messages[1].content.match(/for (\w+) ONLY/)[1];
    if (malformedCalls === 1) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'prose, not JSON' } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ assets: starterAssets(config, analysis, [platform]).assets }) } }] });
  };
  const recovered = await generateWithAI(config, analysis, ['facebook']);
  assert.equal(malformedCalls, 2, 'A malformed reply is retried once by the generation loop');
  assert(recovered.assets.length === 2 && recovered.assets.every(asset => asset.generationMode === 'ai'), 'The second attempt supplies the AI drafts');

  console.log('PASS: 14 starter assets in 3 languages, delivery fields, source filtering, Facebook hook and figure rules in 3 languages, Facebook revision, provider fallback with transient-error retries, English-only LinkedIn prompts with config.language elsewhere, offline LinkedIn language warning, guarded draft-language conversion, model-aware context trimming, grounded single-asset rewriting, partial analyze degradation and provider-outage fail-fast. No paid API requests.');
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = originalKey;
  await fs.rm(temp, { recursive: true, force: true });
}
