import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const source = 'This is a fictional review test. The company opens at 09:00. '.repeat(10);
const analysis = { summaryShort: 'Review test', summaryLong: 'Fictional test data.', keyTerms: ['Test'], riskFlags: ['Review the source.'], facts: Array.from({length:58}, (_,i)=>({id:`F${String(i+1).padStart(3,'0')}`,type:'claim',text:`Test fact ${i+1}`,sourceExcerpt:i===57?'Invented quotation':'The company opens at 09:00.',sourceLocation:'Test paragraph',verified:false,usableOnSocial:true,riskLevel:'low'})) };
const browser = await chromium.launch();
try {
 const page=await browser.newPage(); const errors=[]; const requests=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/analyze',r=>r.fulfill({json:analysis}));
 await page.route('**/api/generate',async r=>{requests.push(r.request().postDataJSON());await r.fulfill({json:{assets:[],usedFallback:false}});});
 await page.route('**/api/projects**', r => r.fulfill({json:{enabled:false,projects:[]}}));
 await page.goto(process.env.TEST_BASE_URL || 'http://localhost:3002');
 await page.locator('.locale-switcher select').selectOption('en');
 await page.locator('.source-textarea').fill(source);
 await page.getByRole('button',{name:'Generate social drafts',exact:true}).click();
 await page.getByRole('button',{name:'Regenerate',exact:true}).waitFor();
 await page.waitForTimeout(500);
 assert(requests.length>0, 'Must generate directly without visiting fact controls');
 for(const request of requests){
  assert.equal(request.analysis.sourceReviewBasis,'team-reviewed-article');
  assert.equal(request.analysis.facts.filter(f=>f.verified && f.usableOnSocial).length,57);
  assert.equal(request.analysis.facts[57].verified,false);
  assert.equal(request.analysis.facts[57].usableOnSocial,false);
 }
 await page.locator('.nav-item').filter({hasText:'Source references'}).click();
 assert.equal(await page.locator('.fact-row').count(),10);
 assert.equal(await page.locator('.fact-details[open]').count(),0);
 assert.equal(await page.locator('.fact-checkbox.checked').count(),9);
 await page.locator('.fact-details summary').nth(1).click();
 await page.locator('.fact-input').nth(1).fill('Edited test fact');
 assert.equal(await page.locator('.fact-checkbox.checked').count(),8);
 await page.getByRole('button',{name:'Generate confirmed facts',exact:true}).click();
 await page.waitForTimeout(500);
 assert.equal(requests.at(-1).analysis.facts.filter(f=>f.verified && f.usableOnSocial).length,56);
 // Extraction failure must keep the source and must not start generation.
 await page.getByRole('button',{name:'Workspace',exact:true}).click();
 await page.locator('.source-textarea').fill(source+' Updated source.');
 await page.route('**/api/analyze',r=>r.fulfill({status:502,json:{error:'Test extraction failure'}}));
 const previous=requests.length;
 await page.getByRole('button',{name:'Generate social drafts',exact:true}).click();
 await page.getByText('Test extraction failure',{exact:true}).waitFor();
 assert.equal(requests.length,previous);
 assert((await page.locator('.source-textarea').inputValue()).includes('Updated source.'));
 assert.deepEqual(errors,[]);
 console.log('PASS: reviewed article generates directly, unmatched evidence excluded, optional reference controls preserve editing safeguards, failure preserves source without generating. No paid AI calls.');
}finally{await browser.close();}
