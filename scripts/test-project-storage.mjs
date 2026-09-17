import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import mysql from 'mysql2/promise';
process.loadEnvFile('.env.local');
const base=process.env.TEST_BASE_URL || 'http://localhost:3002';
const browser=await chromium.launch(); const owners=[];
const context=await browser.newContext();
const source='Fictional storage test. Example Company opens at 09:00 and closes at 17:00. '.repeat(4);
try {
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/analyze',r=>r.fulfill({json:{summaryShort:'Storage test',summaryLong:'Fictional source.',keyTerms:['Test'],riskFlags:[],facts:[{id:'F001',type:'claim',text:'Example Company opens at 09:00.',sourceExcerpt:'Example Company opens at 09:00 and closes at 17:00.',sourceLocation:'Test',verified:false,usableOnSocial:true,riskLevel:'low'}]}}));
 await page.route('**/api/generate',r=>{const p=r.request().postDataJSON().platforms[0];return r.fulfill({json:{assets:[{id:`storage-${p}`,platform:p,assetType:'test',title:'Storage test '+p,content:'Persisted fictional content.',cta:'Read the test',factIds:['F001'],riskFlags:[],status:'needs_review',generationMode:'ai',meta:{note:'test'},updatedAt:new Date().toISOString()}],usedFallback:false}});});
 await page.goto(base); await page.locator('.locale-switcher select').selectOption('en');
 await page.locator('.project-storage [role=status]').filter({hasText:'Ready to save'}).waitFor({timeout:20000});
 await page.locator('.source-textarea').fill(source);
 await page.getByRole('button',{name:'Generate social drafts',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.asset-card:not(.skeleton)').length===11);
 await page.waitForFunction(()=>document.querySelector('.project-storage [role=status]')?.textContent==='Saved to MySQL');
 const list=await (await context.request.get(base+'/api/projects')).json(); assert(list.projects.length>=1);
 const id=list.projects.find(p=>p.assetCount===11)?.id;assert(id);
 await page.reload(); await page.waitForFunction(()=>document.querySelectorAll('.asset-card:not(.skeleton)').length===11);
 assert.equal(await page.locator('.asset-preview').first().innerText(),'Persisted fictional content.');
 assert.equal(await page.locator('.status-badge.approved').count(),0,'Persistence must not auto-approve assets');
 const detail=await (await context.request.get(base+`/api/projects?id=${id}`)).json();
 assert.equal(detail.snapshot.sourceText,source);assert.equal(detail.snapshot.assets.length,11);
 const other=await browser.newContext();
 await other.request.get(base+'/api/projects');
 const forbidden=await other.request.get(base+`/api/projects?id=${id}`);assert.equal(forbidden.status(),404);
 owners.push(...(await other.cookies()).filter(c=>c.name==='polaris-project-owner').map(c=>c.value));await other.close();
 const crossOrigin=await context.request.put(base+'/api/projects',{headers:{Origin:'https://untrusted.example'},data:detail});assert.equal(crossOrigin.status(),403);
 const invalid=await context.request.put(base+'/api/projects',{headers:{Origin:base},data:{...detail,snapshot:{...detail.snapshot,assets:[{content:{invalid:true}}]}}});assert.equal(invalid.status(),400);
 const next={...detail,snapshot:{...detail.snapshot,generationRun:'new-storage-test-run',assets:[]}};
 const saved=await context.request.put(base+'/api/projects',{headers:{Origin:base},data:next});assert.equal(saved.status(),200);
 const conflict=await context.request.put(base+'/api/projects',{headers:{Origin:base},data:next});assert.equal(conflict.status(),409);
 const history=await (await context.request.get(base+'/api/projects')).json();assert(history.projects.some(p=>p.id!==id&&p.assetCount===11),'A new run must archive previous generated content');
 assert.deepEqual(errors,[]);
 console.log('PASS: real MySQL autosave, generated assets/source restored after reload, no automatic approval, browser isolation, CSRF rejection, schema validation, optimistic conflicts and generation archiving. AI mocked; no paid requests.');
} finally {
 owners.push(...(await context.cookies()).filter(c=>c.name==='polaris-project-owner').map(c=>c.value));
 await browser.close();
 const db=await mysql.createConnection({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE});
 try {for(const token of owners) await db.execute('DELETE FROM projects WHERE owner_hash=?',[createHash('sha256').update(token).digest('hex')]);}finally{await db.end();}
}
