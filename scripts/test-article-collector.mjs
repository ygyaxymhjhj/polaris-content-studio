import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import ts from 'typescript';
const nativeRequire = createRequire(import.meta.url);
const code = ts.transpileModule(await fs.readFile('src/lib/article-collector.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const calls = [];
const text = 'This is an exact public article paragraph with sufficient detail for extraction. '.repeat(8);
const html = `<h1>Source article</h1><div id="articleInfo"><h3>Short heading</h3><p>${text}</p><p>Short fact</p></div><article><p>UNRELATED</p></article>`;
const network = { request(url, options, onResponse) {
  const req = new EventEmitter();
  req.destroy = error => { if (error) req.emit('error', error); };
  req.end = () => options.lookup(url.hostname, { all: true }, (error, records) => {
    if (error) { req.emit('error', error); return; }
    assert.equal(records[0].address, '93.184.216.34', 'connection uses validated pinned address');
    calls.push(url.href);
    setTimeout(() => {
      let body = html, status = 200, headers = { 'content-type': 'text/html' };
      if (url.pathname === '/blocked') { status = 403; body = 'Access Denied'; }
      if (url.pathname === '/redirect') { status = 302; headers.location = 'http://127.0.0.1/private'; }
      if (url.pathname === '/dynamic') body = `<html><head><title>Dynamic article</title></head><body><div id="articleInfo"></div><script>setTimeout(()=>{document.getElementById('articleInfo').innerHTML=${JSON.stringify(`<p>${text}</p>`) }},100)</script></body></html>`;
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status; response.headers = headers;
      onResponse(response);
    }, 10);
  });
  return req;
} };
const compiled = { exports: {} };
new Function('require', 'exports', 'module', code)(name => {
  if (name === 'node:https' || name === 'node:http') return network;
  if (name === 'node:dns/promises') return { lookup: async host => [{ address: host === 'private.example' ? '127.0.0.1' : '93.184.216.34', family: 4 }] };
  return nativeRequire(name);
}, compiled.exports, compiled);
const { publicUrl, isBlockedAddress, collectArticle, extractPublicArticle } = compiled.exports;
for (const raw of ['http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://10.0.0.1/', 'file:///etc/passwd', 'https://user:pass@example.com/', 'http://example.com:8800/']) assert.throws(() => publicUrl(raw));
assert(isBlockedAddress('::ffff:192.168.1.1'));
assert(extractPublicArticle(html, 'https://example.com/newsdetail/1').text.includes('Short fact'));
assert(!extractPublicArticle(html, 'https://example.com/newsdetail/1').text.includes('UNRELATED'));
assert.throws(() => extractPublicArticle('<title>Access Denied</title><main>'+text+'</main>', 'https://example.com'), /verification/);
await assert.rejects(collectArticle('https://private.example/article'), /private/);
await assert.rejects(collectArticle('https://example.com/redirect'), /not allowed/);
const same = await Promise.all([collectArticle('https://example.com/same'), collectArticle('https://example.com/same')]);
assert.equal(same[0].text, same[1].text);
assert.equal(calls.filter(url => url.endsWith('/same')).length, 1);
assert((await collectArticle('https://example.com/same')).cached);
await assert.rejects(collectArticle('https://example.com/blocked'), error => error.code === 'SOURCE_ACCESS_DENIED');
await assert.rejects(collectArticle('https://example.com/blocked'), error => error.code === 'SOURCE_ACCESS_DENIED');
assert.equal(calls.filter(url => url.endsWith('/blocked')).length, 1, 'denial is not retried or rendered');
const previous = process.env.ARTICLE_RENDER_BROWSER;
process.env.ARTICLE_RENDER_BROWSER = 'true';
try {
 const dynamic = await collectArticle('https://example.com/dynamic');
 assert.equal(dynamic.collectionMode, 'browser');
 assert(dynamic.text.includes('exact public article'));
} finally { if (previous === undefined) delete process.env.ARTICLE_RENDER_BROWSER; else process.env.ARTICLE_RENDER_BROWSER = previous; }
console.log('PASS: pinned public DNS, private/credential URL rejection, safe redirects, article extraction, shared requests/cache, denial stop, and real Chromium rendering against mocked public responses.');
