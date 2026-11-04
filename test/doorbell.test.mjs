import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceReady,displayEnabled,eventAlarm} from '../src/doorbell.mjs';
import {parseDoorbellMail} from '../src/doorbell-mail.mjs';
import {doorbellController} from '../public/doorbell-view.mjs';
const config={personEntity:'binary_sensor.inngang_person',ringEntity:'event.inngang_doorbell',localAlarmEntity:'event.inngang_lokale_alarmer_inngang_lokal_alarm'};
test('explicit activation before physical testing does not claim passed acceptance',()=>{const report={enabled:true,userEnabledBeforeTesting:true};assert.equal(displayEnabled(report),true);assert.equal(acceptanceReady(report),false);assert.equal(displayEnabled({...report,enabled:false}),false);assert.equal(displayEnabled({enabled:true}),false);});

test('person repeats do not extend; a new press resets one existing overlay; close releases once',()=>{
 let clock=0,next=0,opened=0,closed=0;const timers=new Map(),titles=[];
 const controller=doorbellController({open:()=>opened++,close:()=>closed++,setTitle:v=>titles.push(v),now:()=>clock,schedule:(f,ms)=>{timers.set(++next,{f,at:clock+ms});return next;},cancel:id=>timers.delete(id)});
 assert.equal(controller.alarm({kind:'person'}),true);clock=10000;
 assert.equal(controller.alarm({kind:'person'}),false);assert.equal(controller.remaining(),20);assert.equal(opened,1);
 assert.equal(controller.alarm({kind:'ring'}),true);assert.equal(controller.remaining(),30);assert.equal(opened,1);assert.equal(timers.size,1);assert.equal(titles.at(-1),'Noen ringer på');
 clock=40000;[...timers.values()][0].f();assert.equal(closed,1);assert.equal(controller.isOpen(),false);controller.dismiss();assert.equal(closed,1);
 assert.equal(controller.alarm({kind:'ring',at:new Date(clock-6000).toISOString()}),false);
});
test('only fresh typed camera state changes are alarms, including repeated ring timestamps',()=>{
 const now=Date.now(),event=(id,old,next,at=now)=>({time_fired:new Date(at).toISOString(),data:{entity_id:id,old_state:old,new_state:next}});
 assert.equal(eventAlarm(event(config.personEntity,{state:'off'},{state:'on'}),config,now).kind,'person');
 assert.equal(eventAlarm(event(config.personEntity,null,{state:'on'}),config,now),null);
 assert.equal(eventAlarm(event(config.personEntity,{state:'off'},{state:'on',attributes:{restored:true}}),config,now),null);
 assert.equal(eventAlarm(event('binary_sensor.inngang_motion',{state:'off'},{state:'on'}),config,now),null);
 const next={state:new Date(now).toISOString(),attributes:{event_type:'press'}};
 assert.equal(eventAlarm(event(config.ringEntity,{state:'unknown'},next),config,now).kind,'ring');
 assert.equal(eventAlarm(event(config.ringEntity,next,next),config,now),null);
 assert.equal(eventAlarm(event(config.ringEntity,{state:'unknown'},next,now-6000),config,now),null);
});
test('activation requires actual person and ring series, visible frames and sleep/UI checks',()=>{
 const sample={physical:true,haReceived:true,firstFrameMs:4000,fromSleep:true};const report={enabled:true,personTests:Array(10).fill(sample),ringTests:Array(10).fill(sample),uiVerified:true,returnsToSleepVerified:true};
 assert.equal(acceptanceReady(report),true);assert.equal(acceptanceReady({...report,ringTests:Array(9).fill(sample)}),false);assert.equal(acceptanceReady({...report,uiVerified:false}),false);
 assert.equal(acceptanceReady({...report,ringTests:[...report.ringTests,{...sample,haReceived:false}]}),false);assert.equal(acceptanceReady({...report,personTests:Array(10).fill({...sample,firstFrameMs:null})}),false);
});
test('MIME is decoded but generic/test text, stale dates and wrong identities cannot become accepted camera alarms',async()=>{
 const now=Date.now();const raw=body=>`Date: ${new Date(now).toUTCString()}\r\nFrom: camera@doorbell.local\r\nTo: dashboard@doorbell.local\r\nSubject: =?UTF-8?B?${Buffer.from('Door alarm').toString('base64')}?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body).toString('base64')}`;
 const person=await parseDoorbellMail(raw('Alarm Event: Person'),{now});assert.equal(person.kind,'person');assert.equal(person.fresh,true);assert.equal(person.validSender,true);assert.equal(person.validRecipient,true);
 assert.equal((await parseDoorbellMail(raw('Alarm Event: Visitor'),{now})).kind,'ring');
 assert.equal((await parseDoorbellMail(raw('A person configured this test doorbell email'),{now})).kind,null);
 assert.equal((await parseDoorbellMail(raw('Alarm Event: Motion'),{now})).kind,null);
 assert.equal((await parseDoorbellMail(raw('Alarm Event: Visitor'),{now:now+40000})).fresh,false);
 assert.equal((await parseDoorbellMail(raw('Alarm Event: Visitor').replace('camera@doorbell.local','wrong@example.com'),{now})).validSender,false);
});
