import {readConfig} from './config.mjs';
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { activityCoverage, validateActivityRun } from './activity-coverage.mjs';
import { readJsonArg, slimCompletion, slimReviewQueue, slimResult, slimProfile, slimPhone, buildNext } from './cli-lib.mjs';

const base = process.env.FAMILIEN_API ?? "http://127.0.0.1:4318";
const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((arg) => /^--[a-z-]+$/.test(arg)));
const [command, ...args] = rawArgs.filter((arg) => !/^--[a-z-]+$/.test(arg));
const json = (arg) => readJsonArg(arg);
const activityConfig = () => readConfig('activity-sources.json');
const outputPath = (path) => { mkdirSync(dirname(path), { recursive: true }); return path; };

function datedFinding(finding) {
  if (!finding || !Number.isFinite(Date.parse(finding.start)) || !Number.isFinite(Date.parse(finding.end)) || Date.parse(finding.end) <= Date.parse(finding.start)) {
    throw new Error("Hvert funn må ha gyldig start og end. Bruk en tydelig merket oppfølgingsdato når hendelsesdatoen er ukjent.");
  }
}

async function request(path, method = "GET", data) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json", "X-Family-Request":"1" },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

const asList = (input) => Array.isArray(input) ? input : [input];
const postEach = async (path, input) => {
  const results = [];
  for (const item of asList(input)) results.push(await request(path, "POST", item));
  return Array.isArray(input) ? results : results[0];
};

async function activityState() {
  return activityCoverage(activityConfig(), (await request('/api/activities')).sources);
}

// Utfører én kommando og returnerer det som skal vises. Brukes både direkte og fra `batch`.
async function execute(command, args, flags) {
  let result;
  switch (command) {
    case 'shopping': result=await request('/api/shopping');break;
    case 'shopping-queue': result=await request('/api/shopping/queue');break;
    case 'shopping-orders': result=await request('/api/shopping/orders','POST',json(args[0]));break;
    case 'shopping-settings': result=await request('/api/shopping/settings','POST',json(args[0]));break;
    case 'shopping-watch': result=await request('/api/shopping/watch','POST',json(args[0]));break;
    case 'shopping-offer': result=await request('/api/shopping/offer','POST',json(args[0]));break;
    case 'shopping-review': result=await request('/api/shopping/review','POST',json(args[0]));break;
    case 'shopping-nutrition': result=await request('/api/shopping/nutrition','POST',json(args[0]));break;
    case 'oda-sync': result=await request('/api/shopping/oda/sync','POST',{});break;
    case 'kassal-configure': result=await request('/api/shopping/kassal/configure','POST',json(args[0]));break;
    case 'kassal-search': result=await request('/api/shopping/kassal/search','POST',json(args[0]));break;
    case 'kassal-product': result=await request('/api/shopping/kassal/product','POST',json(args[0]));break;
    case 'kassal-ean': result=await request('/api/shopping/kassal/ean','POST',json(args[0]));break;
    case 'kassal-stores': result=await request('/api/shopping/kassal/stores','POST',json(args[0]));break;
    case 'next': {
      const [phone, calendarActions, completion, queue, activities, collector, feed, shopping] = await Promise.all([
        request('/api/phone/inbox'), request('/api/calendar-actions'), request('/api/completion'), request('/api/review-queue'), activityState(), request('/api/collector/status'), request('/api/activity-feed'), request('/api/shopping/queue')
      ]);
      result = buildNext({ phone, calendarActions, completion, queue, activities, collector, feed, shopping });
      result.shopping=shopping;
      break;
    }
    case 'event': {
      try {result=await request(`/api/events/${args[0]}`);}
      catch(error) {if(!/Ukjent endepunkt/.test(error.message))throw error;result=(await request('/api/state')).events[args[0]];if(!result)throw Error('Ukjent oppføring.');}
      break;
    }
    case 'calendar-actions': result=await request('/api/calendar-actions');break;
    case 'split-homework': result=await request(`/api/events/${args[0]}/split-homework`,'POST',json(args[1]));break;
    case 'merge-events': result=await request('/api/events/merge','POST',json(args[0]));break;
    case 'backup': result=await request('/api/maintenance/backup','POST',{label:args[0]??'manual'});break;
    case 'calendar-action': result=await request(`/api/events/${args[0]}/calendar-action`,'POST',json(args[1]));break;
    case "phone-invite": result=await request('/api/phone/invite','POST');break;
    case "phone-inbox": result=slimPhone(await request('/api/phone/inbox'),{all:flags.has('--all')});break;
    case "phone-review": result=await request(`/api/phone/inbox/${args[0]}/review`,'POST',json(args[1]));break;
    case "phone-revoke": result=await request('/api/phone/devices/revoke','POST');break;
    case "activities": result=await request('/api/activities'); break;
    case "activity-queue": result=await activityState(); break;
    case "activity-intake": result=await request('/api/activities','POST',json(args[0])); break;
    case "activity-source": result=await request('/api/activity-source-status','POST',json(args[0])); break;
    case "activity-plan": result=await request(`/api/activities/${args[0]}/plan`,'POST',json(args[1])); break;
    case "waste-refresh": result = await request('/api/waste/refresh','POST',{force:flags.has('--force')}); break;
    case "status": result = await request("/api/state"); break;
    case "profile": result = slimProfile(await request("/api/profile"), { full: flags.has('--full') }); break;
    case "runs": result = await request("/api/runs"); break;
    case "collector-status": result = await request("/api/collector/status"); break;
    case 'collected-list': result = await request(`/api/collector/list?source=${encodeURIComponent(args[0])}&surface=${encodeURIComponent(args[1]??'')}`); break;
    case "change-completion": result = await request('/api/change-completion'); break;
    case "dispatch-status": result = await request('/api/ingestion/dispatcher'); break;
    case "dispatch-resume-after-login": result = await request('/api/ingestion/dispatcher/resume-after-login','POST',{}); break;
    case "google-status": result = await request('/api/google/status'); break;
    case "google-configure": result = await request('/api/google/configure','POST',json(args[0])); break;
    case "google-connect": result = await request('/api/google/authorize','POST',{}); break;
    case "publish": result = await request('/api/google/publish','POST',{}); break;
    case "facebook-sweep": result = await request("/api/collector/facebook-sweep", "POST"); break;
    case "collector-refresh": result = await request("/api/collector/refresh", "POST"); break;
    case "collected": result = await request(`/api/collector/item?id=${encodeURIComponent(args[0])}`); break;
    case "resources": result = await request(`/api/resources${args[0]?'?externalId='+encodeURIComponent(args[0]):''}`); break;
    case "resource": result = await request(`/api/resources/item?id=${encodeURIComponent(args[0])}`); break;
    case "resource-fetch": result = await request('/api/resources/fetch','POST',{id:args[0],force:flags.has('--force')}); break;
    case "resource-register": result = await request('/api/resources/register','POST',json(args[0])); break;
    case "resource-follow": result = await request('/api/resources/follow','POST',{id:args[0],urls:json(args[1])}); break;
    case "resource-attach": result = await request('/api/resources/attach','POST',{id:args[0],rawId:args[1]}); break;
    case "resource-export": {
      const response=await fetch(`${base}/api/resources/original?id=${encodeURIComponent(args[0])}`);
      if(!response.ok)throw Error((await response.json()).error);
      writeFileSync(outputPath(args[1]),Buffer.from(await response.arrayBuffer()));result={path:args[1]};break;
    }
    case "resource-render": {
      const response=await fetch(`${base}/api/resources/original?id=${encodeURIComponent(args[0])}`);
      if(!response.ok)throw Error((await response.json()).error);
      const {renderPdfPages}=await import('./resources.mjs');
      result={paths:await renderPdfPages(Buffer.from(await response.arrayBuffer()),args[1],args[2]?json(args[2]):undefined)};break;
    }
    case "activity-feed": result = await request("/api/activity-feed"); break;
    case "activity-candidates": result = await request("/api/activity-feed/candidates", "POST", { ack: flags.has('--ack'), limit: Number(args[0]) || 60,full:flags.has('--full') }); break;
    case "activity-page": result = await request("/api/activity-feed/page", "POST", { id: args[0], ack: flags.has('--ack'), full:flags.has('--full') }); break;
    case "activity-facebook": result = await request('/api/activity-facebook','POST',{id:args[0],ack:flags.has('--ack')}); break;
    case "activity-refresh": result = await request("/api/activity-feed/refresh", "POST", { force: flags.has('--force'),sourceId:args[0] }); break;
    case "usage": result = await request(`/api/usage?days=${Number(args[0]) || 7}`); break;
    case "run-history": result = await request(`/api/run-history${args[0] ? `?before=${encodeURIComponent(args[0])}` : ""}`); break;
    case "raw-item": result = await request(`/api/raw/${args[0]}`); break;
    case "source-item": result=await request('/api/source-items','POST',{source:args[0],externalIds:[args[1]]});break;
    case "source-items": result=await request('/api/source-items','POST',json(args[0]));break;
    case "profile-queue": result = await request("/api/profile-queue"); break;
    case "document-status": result = await request(`/api/documents/${args[0]}`); break;
    case "document-check": result = await request(`/api/documents/${createHash("sha256").update(readFileSync(args[0])).digest("hex")}`); break;
    case "document-review": result = await request(`/api/raw/${args[0]}/attachments/${args[1]}/review`, "POST", json(args[2])); break;
    case "profile-fact": result = await request("/api/profile/facts", "POST", json(args[0])); break;
    case "profile-review": result = await request(`/api/raw/${args[0]}/profile-review`, "POST", json(args[1])); break;
    case "review-queue": result = slimReviewQueue(await request("/api/review-queue"), { full: flags.has('--full') }); break;
    case "completion": result = slimCompletion(await request("/api/completion"), { history: flags.has('--history'), full: flags.has('--full') }); break;
    case "raw": result = (await request("/api/state")).rawItems; break;
    case "events": result = (await request("/api/state")).events; break;
    case "export-card": {
      const response = await fetch(`${base}/api/raw/${args[0]}/card`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const path = outputPath(args[1] ?? `tmp/agent/${args[0]}-card.txt`);
      writeFileSync(path, await response.text());
      result = { path };
      break;
    }
    case "source-status":
    case "source": result = await request("/api/source-status", "POST", json(args[0])); break;
    case "observe-list": {
      // surfaceStatus (valgfritt) lagrer overflatens dekning i samme kall. Serveren validerer fortsatt Vigilo-kravene.
      const { surfaceStatus, ...input } = json(args[0]);
      result = await request("/api/observe-list", "POST", input);
      if (surfaceStatus) {
        const needsReview = result.decisions.filter((entry) => entry.needsReview).length;
        const status = { source: input.source, surface: input.surface, ...surfaceStatus };
        if (needsReview && status.health === "ok") { status.health = "partial"; status.complete = false; result.warning = `${needsReview} elementer trenger gjennomgang; overflaten er lagret som partial.`; }
        result.surfaceStatus = await request("/api/surface-status", "POST", status);
      }
      break;
    }
    case "mark-reviewed": result = await postEach("/api/mark-reviewed", json(args[0])); break;
    case "surface": result = await postEach("/api/surface-status", json(args[0])); break;
    case "intake": {
      // markReviewed (liste) og profileReview kan følge med og utføres rett etter at råelementet er lagret.
      const { markReviewed, profileReview, ...input } = json(args[0]);
      for (const finding of input.findings ?? []) datedFinding(finding);
      result = await request("/api/raw", "POST", input);
      const rawId = result.item?.id;
      if (profileReview) result.profileReview = await request(`/api/raw/${rawId}/profile-review`, "POST", profileReview);
      if (markReviewed) result.markReviewed = await postEach("/api/mark-reviewed", asList(markReviewed).map((entry) => ({ source: input.source, externalId: input.externalId, rawId, ...entry })));
      break;
    }
    case "finding": {
      const input = json(args[1]);
      datedFinding(input);
      result = await request(`/api/raw/${args[0]}/findings`, "POST", input);
      break;
    }
    case "drive": result = await request(`/api/raw/${args[0]}/drive`, "POST", { attachmentId: args[1] === "-" ? null : args[1], url: args[2] }); break;
    case "calendar": result = await request(`/api/events/${args[0]}/calendar`, "POST", json(args[1])); break;
    case "run": {
      const input = json(args[0]);
      if (input.outcome !== 'skipped' && !['telefon','familiehandlinger','kildeendringer','handel'].includes(input.scope)) validateActivityRun(await activityState(), input);
      result = await request("/api/runs", "POST", input);
      break;
    }
    case "begin-run": result = await request("/api/run-lock", "POST"); break;
    case "renew-run": result = await request("/api/run-lock", "PUT", { token: args[0] }); break;
    case "end-run": result = await request("/api/run-lock", "DELETE", { token: args[0] }); break;
    case "attach": {
      const rawId = args[0], file = args[1], fileName = args[2] ?? file.split(/[\\/]/).pop();
      const mimeType = fileName.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
      const response = await fetch(`${base}/api/raw/${rawId}/attachments`, {
        method: "POST", headers: { "Content-Type": mimeType, "X-File-Name": encodeURIComponent(fileName) }, body: readFileSync(file)
      });
      result = await response.json();
      if (!response.ok) throw new Error(result.error);
      break;
    }
    case "export-attachment": {
      const response = await fetch(`${base}/api/raw/${args[0]}/attachments/${args[1]}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const path = outputPath(args[2]);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      result = { path };
      break;
    }
    default: throw new Error("Bruk: next | change-completion | dispatch-status | dispatch-resume-after-login | resources [EXTERNAL_ID] | resource ID | resource-fetch ID | resource-follow ID JSON_URLS | resource-attach ID RAW_ID | resource-export ID FILE | resource-render ID DIR [JSON_PAGES] | google-status | google-configure FILE | google-connect | publish | activity-facebook ID [--ack] | activity-candidates [--ack] | activity-page ID [--ack] | activity-feed | activity-refresh | collector-status | collected-list SOURCE [SURFACE] | collected EXTERNAL_ID | collector-refresh | facebook-sweep | batch '[{cmd,args,input?}]' | usage [DAGER] | completion [--history|--full] | review-queue [--full] | begin-run | renew-run TOKEN | end-run TOKEN | phone-inbox | calendar-actions | activity-queue | profile | source FILE | observe-list FILE | mark-reviewed FILE | surface FILE | intake FILE | finding RAW_ID FILE | split-homework EVENT_ID FILE | profile-review RAW_ID FILE | profile-fact FILE | document-check FILE | document-review RAW_ID ATTACHMENT_ID FILE | export-card RAW_ID [FILE] | attach RAW_ID FILE [NAME] | drive RAW_ID ATTACHMENT_ID_OR_DASH URL | calendar EVENT_ID FILE | run FILE | source-items FILE | source-item SOURCE ID | raw-item RAW_ID | event EVENT_ID | status | runs | activities | activity-intake FILE | activity-source FILE | activity-plan ID FILE | waste-refresh [--force] | document-status SHA256 | export-attachment RAW_ID ATTACHMENT_ID FILE. FILE kan være fil, - (stdin) eller inline JSON. Legg til --pretty for innrykk.");
  }
  return ['intake', 'finding', 'calendar', 'calendar-action', 'drive', 'attach'].includes(command) ? slimResult(result, { full: flags.has('--full') }) : result;
}

const print = (value) => console.log(flags.has('--pretty') ? JSON.stringify(value, null, 2) : JSON.stringify(value));

// batch: flere kommandoer i ett kall (hver runde til modellen koster hele konteksten på nytt). Kjøres i rekkefølge og stopper ved første feil.
// Eksempel: batch '[{"cmd":"drive","args":["RAW","-","URL"]},{"cmd":"calendar","args":["EVENT"],"input":{...}}]'
async function main() {
  if (command === 'batch') {
    const steps = json(args[0]);
    if (!Array.isArray(steps) || !steps.length) throw new Error('batch krever en liste med {cmd, args, input?}.');
    const results = [];
    for (const step of steps) {
      if (!step?.cmd || step.cmd === 'batch') { results.push({ cmd: step?.cmd ?? null, ok: false, error: 'Ugyldig steg.' }); break; }
      const stepArgs = [...(step.args ?? []).map(String)];
      if (step.input !== undefined) stepArgs.push(JSON.stringify(step.input));
      try { results.push({ cmd: step.cmd, ok: true, result: await execute(step.cmd, stepArgs, new Set(step.flags ?? [])) }); }
      catch (error) { results.push({ cmd: step.cmd, ok: false, error: error.message }); break; }
    }
    print({ ok: results.every((entry) => entry.ok), ran: results.length, of: steps.length, results });
    if (!results.every((entry) => entry.ok)) process.exitCode = 1;
    return;
  }
  print(await execute(command, args, flags));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
