import test from 'node:test';
import assert from 'node:assert/strict';
import {weeklyLetters,normalizeWeeklyLetter} from '../src/weekly-letters.mjs';
const members=[{id:'child3',role:'child'},{id:'child4',role:'child'},{id:'child1',role:'child'},{id:'parent1',role:'parent'}];
const raw=(id,week,extra={})=>({id,source:'vigilo',title:`Ukeplan 3A uke ${week}`,memberIds:['child3','child4'],observedAt:'2026-09-25T12:00:00Z',attachments:[{id:`file-${id}`,fileName:`${week}.pdf`}],...extra});
const snapshot=(...items)=>({profile:{members},rawItems:Object.fromEntries(items.map(item=>[item.id,item]))});

test('weekend picks next school week, shared original belongs to both children, adults excluded',()=>{
 const s=snapshot(raw('old',39),raw('next',41));
 const result=weeklyLetters(s,'2026-10-04');
 assert.equal(result.length,2);assert.deepEqual(result.map(x=>x.memberId),['child3','child4']);
 assert.ok(result.every(x=>x.week===41&&x.year===2026&&x.status==='upcoming'&&x.attachmentId==='file-next'));
});
test('current school week wins over an early next-week letter; old fallback is clearly labelled',()=>{
 const s=snapshot(raw('current',41),raw('next',42));
 assert.equal(weeklyLetters(s,'2026-10-08')[0].rawId,'current');
 const old=weeklyLetters(s,'2026-11-02')[0];assert.equal(old.week,42);assert.equal(old.status,'previous');
});
test('selects the week plan, not meeting invitation or math worksheet; no calendar event required',()=>{
 const letter=raw('child1',41,{title:'Ukeplan for uke 41 – 8A',memberIds:['child1'],attachments:[{id:'meeting',fileName:'Foreldremøte 8. trinn.pdf'},{id:'plan',fileName:'Uke 41 8A .pdf'},{id:'math',fileName:'Sett 4.pdf'}]});
 assert.equal(weeklyLetters(snapshot(letter),'2026-10-05')[0].attachmentId,'plan');
 assert.equal(weeklyLetters(snapshot(raw('menu',41,{title:'SFO-meny uke 41'})),'2026-10-05').length,0);
});
test('explicit metadata supports differently named originals and handles year boundaries',()=>{
 const item=raw('explicit',1,{title:'Nytt fra klassen',observedAt:'2026-12-31T12:00:00Z',weeklyLetter:normalizeWeeklyLetter({week:1,year:2027,attachmentId:'original'}),attachments:[{id:'original',fileName:'brev.pdf'}]});
 const chosen=weeklyLetters(snapshot(item),'2027-01-03')[0];assert.equal(chosen.year,2027);assert.equal(chosen.from,'2027-01-04');assert.equal(chosen.attachmentId,'original');
 const inferred=weeklyLetters(snapshot(raw('jan',1,{observedAt:'2026-12-31T12:00:00Z'})),'2027-01-03')[0];assert.equal(inferred.year,2027);
 assert.throws(()=>normalizeWeeklyLetter({week:54,year:2026}));
 const missing=weeklyLetters(snapshot({...item,weeklyLetter:{...item.weeklyLetter,attachmentId:'not-yet-attached'}}),'2027-01-03')[0];
 assert.equal(missing.attachmentId,null,'do not substitute another original for an explicitly selected missing file');
});
