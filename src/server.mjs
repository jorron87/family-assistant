import {readConfig} from './config.mjs';
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, DATA_DIR } from "./store.mjs";
import { refreshWaste } from './waste.mjs';
import {phoneHandler} from './phone-server.mjs';
import {createPhoneDispatcher} from './phone-dispatch.mjs';
import QRCode from 'qrcode';
import {createHomeAssistant} from './home-assistant.mjs';
import {createDoorbell} from './doorbell.mjs';
import {createSessionMaintenance} from './session-maintenance.mjs';
import {createWeather,fixtureWeather} from './weather.mjs';
import {createUsage} from './usage.mjs';
import {createFeedRunner} from './activity-feed-runner.mjs';
import {createResources,collectorResourceRequests} from './resources.mjs';
import {createIngestionDispatcher} from './ingestion-dispatch.mjs';
import {createGooglePublisher} from './google-publisher.mjs';
import {weeklyLetters} from './weekly-letters.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const store = createStore();
const resources = createResources({dataDir:DATA_DIR,store});
const googlePublisher=createGooglePublisher({store,dataDir:DATA_DIR,config:readConfig('sources.json')});
const homeAssistant=createHomeAssistant({config:process.env.FAMILIEN_HOME_ASSISTANT_CONFIG?JSON.parse(readFileSync(process.env.FAMILIEN_HOME_ASSISTANT_CONFIG,'utf8')):readConfig('home-assistant.json'),dataDir:DATA_DIR});
const doorbell=createDoorbell({config:readConfig('doorbell.json'),dataDir:DATA_DIR,homeAssistant});
if(process.env.FAMILIEN_DOORBELL_EMBEDDED==='1'&&!process.env.FAMILIEN_NO_DISPATCH)doorbell.start().catch(()=>console.error('Ringeklokkens lokale mottaker kunne ikke startes.'));
const usage=createUsage({root,dataDir:DATA_DIR});
const feedRunner=createFeedRunner({store,root});
const weatherConfig=readConfig('weather.json');
const weather=createWeather({config:weatherConfig,dataDir:DATA_DIR});
const phoneDispatcher=createPhoneDispatcher({store,root});
const ingestionDispatcher=createIngestionDispatcher({store,resources,root,dataDir:DATA_DIR});
// Nye visningsfiler serveres fra public/ etter navn (ingen stier fra klienten).
const PUBLIC_FILES=new Map([['kiosk.css','text/css; charset=utf-8'],['kiosk-home.mjs','text/javascript; charset=utf-8'],['event-display.mjs','text/javascript; charset=utf-8'],['weather-widget.mjs','text/javascript; charset=utf-8'],['login-status.mjs','text/javascript; charset=utf-8'],['sun.mjs','text/javascript; charset=utf-8'],['dtf.mjs','text/javascript; charset=utf-8'],['home-tasks.mjs','text/javascript; charset=utf-8'],['celebrate.mjs','text/javascript; charset=utf-8']]);
PUBLIC_FILES.set('doorbell-view.mjs','text/javascript; charset=utf-8');PUBLIC_FILES.set('doorbell.css','text/css; charset=utf-8');
PUBLIC_FILES.set('member-colors.mjs','text/javascript; charset=utf-8');
let wasteRefresh;
let restarting=false;
const servers=[];
const dispatchTick=()=>{if(!restarting&&!process.env.FAMILIEN_NO_DISPATCH)phoneDispatcher.tick();};
const host = "127.0.0.1";
const port = Number(process.env.FAMILIEN_PORT ?? 4318);
const sessionMaintenance = createSessionMaintenance({dataDir:DATA_DIR});

function send(res, status, value, type = "application/json; charset=utf-8") {
  const body = Buffer.isBuffer(value) ? value : type.startsWith("application/json") ? Buffer.from(JSON.stringify(value)) : Buffer.from(value);
  res.writeHead(status, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

async function body(req, max = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("Forespørselen er for stor.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function json(req) {
  const bytes = await body(req, 6 * 1024 * 1024);
  return JSON.parse(bytes.toString("utf8"));
}

async function handle(req, res) {
  try {
    const path = new URL(req.url, `http://${host}:${port}`).pathname;
    const method = req.method;
    if(path==='/google-setup'&&method==='GET')return send(res,200,readFileSync(join(root,'public','google-setup.html')),'text/html; charset=utf-8');
    if(path==='/api/google/status'&&method==='GET')return send(res,200,googlePublisher.status());
    if(path==='/api/google/callback'&&method==='GET'){
      await googlePublisher.callback(Object.fromEntries(new URL(req.url,`http://${host}`).searchParams));
      return send(res,200,'Google er tilkoblet. Du kan lukke dette vinduet.','text/plain; charset=utf-8');
    }
    if(path.startsWith('/api/google/')&&method==='POST'){
      if(req.headers['x-family-request']!=='1'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
      if(path==='/api/google/configure')return send(res,200,googlePublisher.configure(await json(req)));
      if(path==='/api/google/authorize')return send(res,200,googlePublisher.authorize());
      if(path==='/api/google/publish')return send(res,200,await googlePublisher.publish());
    }
    if(path==='/api/maintenance/backup'&&method==='POST') {
      if(req.headers['x-family-request']!=='1'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
      return send(res,200,store.backupArchive(await json(req)));
    }
    if(path==='/api/maintenance/restart'&&method==='POST') {
      if(req.headers['x-family-request']!=='1'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
      // Independent ingestion retains its lease; a child agent needs this parent.
      if(phoneDispatcher.status().running||ingestionDispatcher.status().running)return send(res,409,{error:'En agent startet av tjenesten kjører. Prøv omstart når denne er ferdig.'});
      if(restarting)return send(res,409,{error:'Omstart pågår.'});
      restarting=true;
      res.setHeader('Connection','close');
      res.once('finish',()=>{
        doorbell.close();homeAssistant.close();
        let remaining=servers.length;
        for(const server of servers) {
          server.close(()=>{if(--remaining===0)process.exit(0);});
          // The restart response is still active during its finish event.
          // Reap sockets after they transition to idle; active requests drain.
          setImmediate(()=>server.closeIdleConnections());
        }
      });
      return send(res,202,{accepted:true,note:'Avslutter åpne forespørsler og bevarer kjøringslåsen.'});
    }
    if(path==='/api/home-assistant'&&method==='GET')return send(res,200,await homeAssistant.refresh());
    if(path==='/api/doorbell/status'&&method==='GET')return send(res,200,await doorbell.status());
    if(path==='/api/doorbell/events'&&method==='GET')return doorbell.sse(req,res);
    if(path==='/api/doorbell/frame'&&method==='POST'){
      if(req.headers['x-family-request']!=='1'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
      return send(res,200,doorbell.recordFrame(await json(req)));
    }
    if(['/api/home-assistant/command','/api/home-assistant/connect'].includes(path)&&method==='POST') {
      if(req.headers['x-family-request']!=='1'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
      const input=await json(req);return send(res,200,path.endsWith('/connect')?await homeAssistant.connect(input.token):await homeAssistant.command(input));
    }
    if(path==='/send'||path.startsWith('/send/'))return mobileHandle(req,res);
    if(path==='/phone-setup'&&method==='GET')return send(res,200,readFileSync(join(root,'public','phone-admin.html')),'text/html; charset=utf-8');
    if(path==='/phone-admin.js'&&method==='GET')return send(res,200,readFileSync(join(root,'public','phone-admin.js')),'text/javascript; charset=utf-8');
    if(path==='/api/phone/access'&&method==='GET')return send(res,200,readConfig('phone-access.json'));
    if(path==='/api/phone/invite'&&method==='POST') {
      const invite=store.phone.invite(),access=readConfig('phone-access.json');
      const url=`${access.url}#pair=${invite.code}`;
      return send(res,200,{...invite,url,qr:await QRCode.toDataURL(url,{width:256,margin:2})});
    }
    if(path==='/api/phone/devices/revoke'&&method==='POST')return send(res,200,store.phone.revokeDevices());
    if(path==='/api/phone/inbox'&&method==='GET')return send(res,200,store.phone.list());
    if(path==='/api/phone/message'&&method==='POST'){
      if(req.headers['x-family-request']!=='1'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
      const input=await json(req);
      if(!input.senderMemberId||!String(input.text??'').trim())throw Error('Tekst og avsender kreves.');
      const item=store.phone.begin({...input,fileCount:0},'family-chat',{senderMemberId:input.senderMemberId});
      store.phone.submit(item.id,'family-chat');send(res,200,item);queueMicrotask(dispatchTick);return;
    }
    if(path==='/api/phone/dispatcher'&&method==='GET')return send(res,200,phoneDispatcher.status());
    if(path==='/api/ingestion/dispatcher'&&method==='GET')return send(res,200,ingestionDispatcher.status());
    if(path==='/api/ingestion/dispatcher/resume-after-login'&&method==='POST'){
      if(req.headers['x-family-request']!=='1'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
      return send(res,200,ingestionDispatcher.resumeAfterLogin());
    }
    if(path==='/api/change-completion'&&method==='GET')return send(res,200,store.changeCompletion());
    if(path==='/api/calendar-actions'&&method==='GET')return send(res,200,store.calendarActions());
    const calendarAction=path.match(/^\/api\/events\/([a-f0-9]{24})\/calendar-action$/);
    if(calendarAction&&method==='POST')return send(res,200,store.calendarAction(calendarAction[1],await json(req)));
    const singleEvent=path.match(/^\/api\/events\/([a-f0-9]{24})$/);
    if(singleEvent&&method==='GET') {const event=store.event(singleEvent[1]);return send(res,event?200:404,event??{error:'Ukjent oppføring.'});}
    const eventHistory=/^\/api\/events\/([a-f0-9]{24})\/history$/.exec(path);
    if(eventHistory&&method==='GET'){const original=store.eventHistory(eventHistory[1]);return send(res,original?200:404,original??{error:'Ukjent oppføring.'});}
    if(path==='/api/events/merge'&&method==='POST')return send(res,200,store.mergeEvents(await json(req)));
    const phoneReview=path.match(/^\/api\/phone\/inbox\/([a-f0-9]{24})\/review$/);
    if(phoneReview&&method==='POST')return send(res,200,store.phone.review(phoneReview[1],await json(req)));
    if (path === '/api/waste/refresh' && method === 'POST') {
      const input = await json(req);
      const config = readConfig('sources.json').waste;
      if (!config?.enabled) throw new Error('Renovasjon er ikke konfigurert.');
      wasteRefresh ??= refreshWaste(store,config,{force:input.force===true}).finally(()=>{wasteRefresh=null;});
      return send(res,200,await wasteRefresh);
    }
    if (path === "/api/session-maintenance" && method === "GET") {
      const lease = store.snapshot().runLease;
      return send(res,200,{...sessionMaintenance.snapshot(),busy:!!lease && Date.parse(lease.expiresAt)>Date.now()});
    }
    if (path === '/api/session-maintenance/history' && method === 'GET') return send(res,200,sessionMaintenance.history());
    if (path === "/api/session-maintenance" && method === "POST") {
      return send(res,200,sessionMaintenance.record(await json(req)));
    }
    if (method === "GET" && path === "/health") return send(res, 200, { ok: true, service: "Familien", time: new Date().toISOString(), dataDir: DATA_DIR, pid: process.pid });
    if (method === "GET" && path === "/") return send(res, 200, readFileSync(join(root, "public", "index.html")), "text/html; charset=utf-8");
    if (method === "GET" && path === "/app.css") return send(res, 200, readFileSync(join(root, "public", "app.css")), "text/css; charset=utf-8");
    if (method === "GET" && path === "/app.js") return send(res, 200, readFileSync(join(root, "public", "app.js")), "text/javascript; charset=utf-8");
    if(method==='GET'&&path==='/home-view.mjs')return send(res,200,readFileSync(join(root,'public','home-view.mjs')),'text/javascript; charset=utf-8');
    if (method === "GET" && path === "/profile-editor.mjs") return send(res,200,readFileSync(join(root,"public","profile-editor.mjs")),"text/javascript; charset=utf-8");
    if (method === "GET" && path === "/profile-editor.css") return send(res,200,readFileSync(join(root,"public","profile-editor.css")),"text/css; charset=utf-8");
    if (method === "GET" && PUBLIC_FILES.has(path.slice(1))) return send(res,200,readFileSync(join(root,"public",path.slice(1))),PUBLIC_FILES.get(path.slice(1)));
    if (path === "/api/collector" && method === "POST") {
      if (req.headers['x-family-request'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 403, { error: 'Ugyldig avsender.' });
      const input=await json(req);
      const previous=new Map(store.collectedItems(input.source).map(item=>[item.externalId,JSON.stringify([item.token,item.detail])]));
      const result=store.collectorIngest(input);
      if(!['health','heartbeat'].includes(input.kind))for(const item of store.collectedItems(input.source))if(previous.get(item.externalId)!==JSON.stringify([item.token,item.detail])||resources.list({externalId:item.externalId}).length)resources.discover(item);
      return send(res, 200, result);
    }
    if(path.startsWith('/api/resources')) {
      const query=new URL(req.url,`http://${host}`).searchParams;
      if(method==='GET' && path==='/api/resources')return send(res,200,resources.list({externalId:query.get('externalId'),status:query.get('status')}));
      if(method==='GET' && path==='/api/resources/item')return send(res,200,resources.read(query.get('id')));
      if(method==='GET' && path==='/api/resources/original')return send(res,200,resources.bytes(query.get('id')),'application/octet-stream');
      if(method==='POST') {
        if(req.headers['x-family-request']!=='1' || (req.headers.origin&&!req.headers.origin.startsWith('chrome-extension://')&&new URL(req.headers.origin).host!==req.headers.host))return send(res,403,{error:'Ugyldig avsender.'});
        const input=JSON.parse((await body(req,30*1024*1024)).toString('utf8'));
        if(path==='/api/resources/fetch')return send(res,200,await resources.retrieve(input.id,{force:input.force===true}));
        if(path==='/api/resources/register')return send(res,200,resources.register(input));
        if(path==='/api/resources/attach')return send(res,200,resources.attach(input.id,input.rawId));
        if(path==='/api/resources/follow')return send(res,200,resources.follow(input.id,input.urls));
        if(path==='/api/resources/receive')return send(res,200,await resources.accept(input.id,Buffer.from(input.base64,'base64'),{mimeType:input.mimeType}));
      }
    }
    if (path === "/api/collector/config" && method === "GET") {
      const config=store.collectorConfig();
      config.want.resources=collectorResourceRequests(resources.list());
      return send(res,200,config);
    }
    if (path === "/api/collector/status" && method === "GET") return send(res, 200, store.collectorStatus());
    if (path === '/api/collector/list' && method === 'GET') {
      const params = new URL(req.url,`http://${host}`).searchParams;
      return send(res,200,store.collectedList(params.get('source'),params.get('surface')));
    }
    if (path === "/api/collector/refresh" && method === "POST") return send(res, 200, store.collectorRefresh());
    if (path === "/api/collector/facebook-sweep" && method === "POST") return send(res, 200, store.collectorFacebookSweep());
    if (path === "/api/collector/item" && method === "GET") {
      const item=store.collectedItem(new URL(req.url, `http://${host}`).searchParams.get('id') ?? '');
      return send(res,200,{...item,resources:resources.discover(item)});
    }
    if (path === "/api/activity-feed" && method === "GET") return send(res, 200, store.activityFeedStatus());
    if(path==='/api/activity-facebook'&&method==='POST'){const input=await json(req);return send(res,200,store.activityFacebook(input.id,{ack:input.ack===true}));}
    if (path === "/api/activity-feed/candidates" && method === "POST") return send(res, 200, store.activityFeedCandidates(await json(req)));
    if (path === "/api/activity-feed/page" && method === "POST") { const input = await json(req); return send(res, 200, store.activityFeedPageText(String(input.id ?? ''), { ack: input.ack === true, full:input.full===true })); }
    if (path === "/api/activity-feed/refresh" && method === "POST") { const input = await json(req); return send(res, 200, await feedRunner.run({ force: input.force === true, sourceId:input.sourceId })); }
    if (method === "GET" && path === "/api/usage") return send(res,200,await usage.summary(Math.min(30,Math.max(1,Number(new URL(req.url,`http://${host}`).searchParams.get('days'))||7))));
    if (method === "GET" && path === "/api/weather") {
      const fixture=new URL(req.url,`http://${host}`).searchParams.get('fixture');
      return send(res,200,['rain','dry','snow'].includes(fixture)?fixtureWeather(fixture,Date.now(),weatherConfig):await weather.get());
    }
    if (method === "GET" && path === "/kiosk.mjs") return send(res, 200, readFileSync(join(root, "public", "kiosk.mjs")), "text/javascript; charset=utf-8");
    if (method === "GET" && path === "/mammoth.browser.js") return send(res,200,readFileSync(join(root,"node_modules","mammoth","mammoth.browser.js")),"text/javascript; charset=utf-8");
    if (method === "GET" && path === "/calendar-data.mjs") return send(res, 200, readFileSync(join(root, "public", "calendar-data.mjs")), "text/javascript; charset=utf-8");
    if (method === "GET" && path === "/document-viewer.mjs") return send(res,200,readFileSync(join(root,"public","document-viewer.mjs")),"text/javascript; charset=utf-8");
    if (method === "GET" && /^\/pdfjs\/(build\/pdf(?:\.worker)?\.mjs|(?:cmaps|standard_fonts|wasm)\/[a-zA-Z0-9_.-]+)$/.test(path)) return send(res,200,readFileSync(join(root,"node_modules","pdfjs-dist",path.slice(7))),path.endsWith(".mjs") ? "text/javascript; charset=utf-8" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
    if (method === "GET" && path === "/api/state") {
      // ?view=dashboard: bare det stueskjermen trenger (uten gjennomgangslogg, dokumentkvitteringer og kjøringshistorikk, og bare råkort som avtaler viser til). ETag gir 304 uten kropp når ingenting er endret.
      const snapshot = store.snapshot();
      snapshot.activities=Object.fromEntries(Object.entries(snapshot.activities??{}).filter(([,item])=>!item.mergedInto));
      snapshot.weeklyLetters = weeklyLetters(snapshot);
      const view = new URL(req.url, `http://${host}`).searchParams.get("view");
      let out = snapshot;
      if (view === "dashboard") {
        const referenced = new Set(Object.values(snapshot.events ?? {}).flatMap((event) => event.sourceRefs ?? []));
        for (const letter of snapshot.weeklyLetters) referenced.add(letter.rawId);
        out = { ...snapshot, reviewLedger: {}, documentReviews: {}, runs: [], rawItems: Object.fromEntries(Object.entries(snapshot.rawItems ?? {}).filter(([id]) => referenced.has(id))) };
      }
      const payload = Buffer.from(JSON.stringify(out));
      const etag = '"' + createHash("sha1").update(payload).digest("hex").slice(0, 20) + '"';
      const headers = { "Cache-Control": "no-store", "ETag": etag, "X-Content-Type-Options": "nosniff" };
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8", "Content-Length": payload.length });
      return res.end(payload);
    }
    if (method === "GET" && path === "/api/activities") { const snapshot=store.snapshot(); return send(res,200,{items:Object.values(snapshot.activities).filter(item=>!item.mergedInto && (Date.parse(item.end)>Date.now() || ['pending','blocked'].includes(item.plan?.status))),sources:snapshot.activitySourceStatus}); }
    if (method === "POST" && path === "/api/activities") return send(res,200,store.upsertActivity(await json(req)));
    if (method === "POST" && path === "/api/activity-source-status") return send(res,200,store.activitySource(await json(req)));
    const activityHistory=path.match(/^\/api\/activities\/([a-f0-9]{24})\/history$/);
    if(method==='GET' && activityHistory) {
      const item=store.snapshot().activities[activityHistory[1]];
      return send(res,item?200:404,item??{error:'Ukjent aktivitet.'});
    }
    const activityRoute=path.match(/^\/api\/activities\/([a-f0-9]{24})\/(reaction|plan)$/);
    if (method === "POST" && activityRoute) return send(res,200,activityRoute[2]==="reaction"?store.activityReaction(activityRoute[1],await json(req)):store.activityPlan(activityRoute[1],await json(req)));
    if (method === "GET" && path === "/api/profile") return send(res, 200, store.profile());
    if (method === "POST" && path === "/api/profile/edit") return send(res, 200, store.editProfile(await json(req)));
    if (method === "GET" && path === "/api/runs") return send(res, 200, store.snapshot().runs);
    if (method === "GET" && path === "/api/run-history") return send(res, 200, store.runHistory(new URL(req.url, `http://${host}:${port}`).searchParams.get("before")));
    if (method === "GET" && path === "/api/profile-queue") return send(res, 200, store.completionReport().profileReviews);
    if (method === "POST" && path === "/api/profile/facts") return send(res, 200, store.profileFact(await json(req)));
    if (method === "GET" && path === "/api/review-queue") return send(res, 200, store.reviewQueue());
    if (method === "GET" && path === "/api/completion") return send(res, 200, store.completionReport());
    if (method === "PUT" && path === "/api/profile") return send(res, 200, store.updateProfile(await json(req)));
    if (method === "POST" && path === "/api/raw") return send(res, 200, store.upsertRaw(await json(req)));
    if (method === "POST" && path === "/api/source-status") return send(res, 200, store.updateSource(await json(req)));
    if (method === "POST" && path === "/api/observe-list") return send(res, 200, store.observeListing(await json(req)));
    if (method === "POST" && path === "/api/source-items") return send(res,200,store.sourceItems(await json(req)));
    if (method === "POST" && path === "/api/mark-reviewed") return send(res, 200, store.markReviewed(await json(req)));
    if (method === "POST" && path === "/api/surface-status") return send(res, 200, store.updateSurface(await json(req)));
    if (method === "POST" && path === "/api/runs") return send(res, 200, store.recordRun(await json(req)));
    if (method === "POST" && path === "/api/run-lock") return send(res, 200, store.beginRun());
    if (method === "PUT" && path === "/api/run-lock") return send(res, 200, store.renewRun((await json(req)).token));
    if (method === "DELETE" && path === "/api/run-lock") return send(res, 200, store.endRun((await json(req)).token));
    let match = /^\/api\/raw\/([a-f0-9]{24})\/card$/.exec(path);
    const documentMatch = /^\/api\/documents\/([a-f0-9]{64})$/.exec(path);
    if (method === "GET" && documentMatch) return send(res, 200, store.documentStatus(documentMatch[1]));
    const receiptMatch = /^\/api\/raw\/([a-f0-9]{24})\/attachments\/([a-f0-9-]{36})\/review$/.exec(path);
    const taskMatch = /^\/api\/events\/([a-f0-9]{24})\/tasks\/([a-zA-Z0-9:_-]{1,100})$/.exec(path);
    const visibilityMatch = /^\/api\/events\/([a-f0-9]{24})\/visibility$/.exec(path);
    const splitMatch = /^\/api\/events\/([a-f0-9]{24})\/split-homework$/.exec(path);
    if (method === 'POST' && splitMatch) return send(res,200,store.splitHomework(splitMatch[1],await json(req)));
    if (method === 'POST' && visibilityMatch) {const event=store.setEventVisibility(visibilityMatch[1],await json(req));send(res,200,event);queueMicrotask(dispatchTick);return;}
    if (method === "POST" && taskMatch) return send(res,200,store.checkTask(taskMatch[1],taskMatch[2],await json(req)));
    if (method === "POST" && receiptMatch) return send(res, 200, store.reviewDocument(receiptMatch[1], receiptMatch[2], await json(req)));
    if (method === "GET" && match) {
      const item = store.snapshot().rawItems[match[1]];
      if (!item) return send(res, 404, { error: "Ukjent råelement." });
      const lines = [
        `Tittel: ${item.title}`, `Kilde: ${item.source}`, `Kilde-ID: ${item.externalId}`,
        `Publisert: ${item.publishedAt ?? "ukjent"}`, `Sett: ${item.observedAt}`,
        `Gruppe: ${item.groupName ?? "ukjent"}`, `Personer: ${item.memberIds.join(", ")}`,
        `Original: ${item.sourceUrl ?? "ikke tilgjengelig"}`, "", item.body,
        "", "Vedlegg:", ...item.attachments.map((a) => `${a.fileName} (${a.mimeType}, SHA-256 ${a.sha256})`)
      ];
      return send(res, 200, lines.join("\n"), "text/plain; charset=utf-8");
    }
    match = /^\/api\/raw\/([a-f0-9]{24})$/.exec(path);
    if (method === "GET" && match) {
      const raw = store.snapshot().rawItems[match[1]];
      return send(res, raw ? 200 : 404, raw ?? { error:"Ukjent råelement." });
    }
    match = /^\/api\/raw\/([a-f0-9]{24})\/profile-review$/.exec(path);
    if (method === "POST" && match) return send(res, 200, store.reviewProfile(match[1], await json(req)));
    match = /^\/api\/raw\/([a-f0-9]{24})\/findings$/.exec(path);
    if (method === "POST" && match) return send(res, 200, store.upsertFinding(match[1], await json(req)));
    match = /^\/api\/raw\/([a-f0-9]{24})\/attachments$/.exec(path);
    if (method === "POST" && match) return send(res, 200, store.addAttachment(match[1], {
      fileName: decodeURIComponent(String(req.headers["x-file-name"] ?? "vedlegg")),
      mimeType: String(req.headers["content-type"] ?? "application/octet-stream"),
      bytes: await body(req)
    }));
    match = /^\/api\/raw\/([a-f0-9]{24})\/drive$/.exec(path);
    if (method === "POST" && match) {
      const data = await json(req);
      return send(res, 200, store.linkDrive(match[1], data.attachmentId, data.url));
    }
    match = /^\/api\/events\/([a-f0-9]{24})\/calendar$/.exec(path);
    if (method === "POST" && match) return send(res, 200, store.linkCalendar(match[1], await json(req)));
    match = /^\/api\/raw\/([a-f0-9]{24})\/attachments\/([a-f0-9-]{36})$/.exec(path);
    if (method === "GET" && match) {
      const { attachment, bytes } = store.getAttachment(match[1], match[2]);
      // Only passive formats can be displayed on the dashboard's origin.
      const types = {pdf:"application/pdf",png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",gif:"image/gif"};
      const extension = attachment.fileName.toLowerCase().split(".").pop();
      const view = new URL(req.url,`http://${host}`).searchParams.get("view") === "1" && types[extension];
      res.writeHead(200, {
        "Content-Type": view ? types[extension] : attachment.mimeType,
        "Content-Length": bytes.length,
        "Content-Disposition": `${view ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"
      });
      return res.end(bytes);
    }
    return send(res, 404, { error: "Ukjent endepunkt." });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 422;
    return send(res, status, { error: error.message });
  }
}
const mobileHandle=phoneHandler({store,root,send,body,json,onQueued:dispatchTick,weather,sessionMaintenance});
setInterval(dispatchTick,5000).unref();
// Aktivitetskilder hentes direkte over HTTP med jevne mellomrom (kildene har egne intervaller i config/activity-feeds.json).
if(!process.env.FAMILIEN_NO_DISPATCH&&!process.env.FAMILIEN_NO_FEED){setInterval(()=>feedRunner.run().catch(()=>{}),20*60000).unref();setTimeout(()=>feedRunner.run().catch(()=>{}),90000).unref();}
if(!process.env.FAMILIEN_NO_DISPATCH){setInterval(()=>{if(!restarting)resources.tick().catch(()=>{});},15000).unref();}
setInterval(()=>phoneDispatcher.renew(),15*60000).unref();
setInterval(()=>ingestionDispatcher.renew(),15*60000).unref();
if(!process.env.FAMILIEN_NO_DISPATCH)setInterval(()=>{if(!restarting)ingestionDispatcher.tick();},60000).unref();
setTimeout(dispatchTick,1000).unref();
servers.push(createServer(mobileHandle));
servers.at(-1).listen(port+2,process.env.FAMILIEN_PHONE_HOST??'127.0.0.1',()=>console.log(`Familien mobil: port ${port+2}`));
servers.push(createServer(handle));
doorbell.attach(servers.at(-1));
servers.at(-1).listen(port, host, () => console.log(`Familien: http://${host}:${port}`));
// Family controls are available on the living-room display; ingestion stays private.
servers.push(createServer((req,res) => {
  if(/^\/(?:api\/(?:resources|collector|google)(?:[/?]|$)|google-setup)/.test(req.url))return send(res,req.method==='GET'?403:405,{error:'Kildeoriginaler og integrasjonsoppsett er bare tilgjengelige lokalt på agentporten.'});
  if (req.method !== "GET" && !(req.method === "POST" && /^(?:\/api\/home-assistant\/command|\/api\/doorbell\/frame|\/api\/profile\/edit|\/api\/events\/[a-f0-9]{24}\/(?:tasks\/[a-zA-Z0-9:_-]{1,100}|visibility)|\/api\/activities\/[a-f0-9]{24}\/reaction)$/.test(new URL(req.url,`http://${host}`).pathname))) return send(res,405,{error:"Dashboardet kan bare lese, krysse av, skjule oppføringer og velge aktiviteter."});
  return handle(req,res);
}));
doorbell.attach(servers.at(-1));
servers.at(-1).listen(port+1,host,()=>console.log(`Familien dashboard: http://${host}:${port+1}`));
