import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSchedule,reconcileSchedule,nextDay} from '../src/waste.mjs';
test('groups exact dates without guessed recurrence and handles year rollover',()=>{
  const plan=parseSchedule([{Id:1,Navn:'Restavfall'},{Id:3,Navn:'Mat'}],[{FraksjonId:1,Tommedatoer:['2026-12-31T00:00:00']},{FraksjonId:3,Tommedatoer:['2026-12-31T00:00:00']}]);
  assert.deepEqual(reconcileSchedule(plan,[],'2026-09-27'),[{date:'2026-12-31',names:['Restavfall','Mat']}]);
  assert.equal(nextDay('2026-12-31'),'2027-01-01');
});
test('replaces changed dates inside verified horizon and preserves later dates',()=>{
  assert.deepEqual(reconcileSchedule([{id:1,name:'Rest',dates:['2026-10-07','2026-10-21']}],[{id:1,name:'Rest',dates:['2026-10-06','2026-10-20','2026-11-03']}],'2026-09-27').map(p=>p.date),['2026-10-07','2026-10-21','2026-11-03']);
});
test('empty data, missing fractions and impossible dates are errors, not cancellation',()=>{
  assert.throws(()=>parseSchedule([],[]));
  assert.throws(()=>parseSchedule([{Id:1,Navn:'Rest'}],[{FraksjonId:1,Tommedatoer:['2026-02-30T00:00:00']}]));
  assert.throws(()=>reconcileSchedule([], [{id:1,dates:['2026-10-06']}],'2026-09-27'));
});
