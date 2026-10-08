import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { signIn } from './_login.mjs';

const base=process.env.TEST_BASE_URL || 'http://localhost:3002';
const browser=await chromium.launch();
const source='Fictional storage test. Example Company opens at 09:00 and closes at 17:00. '.repeat(4);
let alice, bob;
try {
 const context=await browser.newContext();
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/analyze',r=>r.fulfill({json:{summaryShort:'Storage test',summaryLong:'Fictional source.',keyTerms:['Test'],riskFlags:[],facts:[{id:'F001',type:'claim',text:'Example Company opens at 09:00.',sourceExcerpt:'Example Company opens at 09:00 and closes at 17:00.',sourceLocation:'Test',verified:false,usableOnSocial:true,riskLevel:'low'}]}}));
 await page.route('**/api/generate',r=>{const p=r.request().postDataJSON().platforms[0];return r.fulfill({json:{assets:[{id:`storage-${p}`,platform:p,assetType:'test',title:'Storage test '+p,content:'Persisted fictional content.',cta:'Read the test',factIds:['F001'],riskFlags:[],status:'needs_review',generationMode:'ai',meta:{note:'test'},updatedAt:new Date().toISOString()}],usedFallback:false}});});
 alice=await signIn(page,base,{displayName:'Storage Alice'});
 // The source panel opens on the URL tab; the paste textarea only exists on the text tab.
 await page.locator('.segmented-tab').nth(1).click();
 await page.locator('.source-textarea').fill(source);
 // Current flow: analyse the source, then generate from the confirmed facts in the references view.
 await page.locator('.distribution-panel .panel-actions .primary-button').click();
 await page.locator('.main-nav .nav-item').nth(1).click();
 await page.getByRole('button',{name:/Generate confirmed facts/}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.asset-card:not(.skeleton)').length===5);
 await page.waitForFunction(()=>document.querySelector('.project-storage [role=status]')?.textContent==='Saved to MySQL');
 const list=await (await context.request.get(base+'/api/projects')).json(); assert(list.projects.length>=1);
 const id=list.projects.find(p=>p.assetCount===5)?.id;assert(id);
 await page.reload(); await page.waitForFunction(()=>document.querySelectorAll('.asset-card:not(.skeleton)').length===5);
 assert.equal(await page.locator('.asset-preview').first().innerText(),'Persisted fictional content.');
 assert.equal(await page.locator('.status-badge.approved').count(),0,'Persistence must not auto-approve assets');
 const detail=await (await context.request.get(base+`/api/projects?id=${id}`)).json();
 assert.equal(detail.snapshot.sourceText,source);assert.equal(detail.snapshot.assets.length,5);
 const anonymous=await browser.newContext();
 assert.equal((await anonymous.request.get(base+'/api/projects')).status(),401,'anonymous access must be refused');
 assert.equal((await anonymous.request.get(base+`/api/projects?id=${id}`)).status(),401);await anonymous.close();
 const other=await browser.newContext();
 bob=await signIn(await other.newPage(),base,{displayName:'Storage Bob'});
 const forbidden=await other.request.get(base+`/api/projects?id=${id}`);assert.equal(forbidden.status(),404,'another account must not read this project');
 await other.close();
 const crossOrigin=await context.request.put(base+'/api/projects',{headers:{Origin:'https://untrusted.example'},data:detail});assert.equal(crossOrigin.status(),403);
 const invalid=await context.request.put(base+'/api/projects',{headers:{Origin:base},data:{...detail,snapshot:{...detail.snapshot,assets:[{content:{invalid:true}}]}}});assert.equal(invalid.status(),400);
 const next={...detail,snapshot:{...detail.snapshot,generationRun:'new-storage-test-run',assets:[]}};
 const saved=await context.request.put(base+'/api/projects',{headers:{Origin:base},data:next});assert.equal(saved.status(),200);
 const conflict=await context.request.put(base+'/api/projects',{headers:{Origin:base},data:next});assert.equal(conflict.status(),409);
 const history=await (await context.request.get(base+'/api/projects')).json();assert(history.projects.some(p=>p.id!==id&&p.assetCount===5),'A new run must archive previous generated content');
 assert.deepEqual(errors,[]);
 console.log('PASS: real MySQL autosave, generated assets/source restored after reload, no automatic approval, account isolation, CSRF rejection, schema validation, optimistic conflicts and generation archiving. AI mocked; no paid requests.');
} finally {
 await browser.close();
 if (alice) await alice.cleanup();
 if (bob) await bob.cleanup();
}
