import { dtf } from "./dtf.mjs";
import {memberColor} from './member-colors.mjs';
import { addDays, eventStartDay, eventsOnDay, mondayOf, monthDays, osloDay, shiftMonth, weekDays } from "./calendar-data.mjs";
import { installKiosk, createRefresh, fetchTimed, fetchOptional } from "./kiosk.mjs";
import * as kioskHome from "./kiosk-home.mjs";
import { cleanTitle, isFollowUp, isWaste } from "./event-display.mjs";
import { loginProblems, loginSummary } from "./login-status.mjs";
import { celebrateTick, celebrateComplete, celebrationFor, pop } from "./celebrate.mjs";
import { isHomework, isExpired } from "./home-tasks.mjs";
import {installShoppingView} from './shopping-view.mjs';

const $ = (selector) => document.querySelector(selector);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const dayDate = (day) => new Date(`${day}T12:00:00Z`);
const displayDay = (day, options) => dtf("nb-NO", { timeZone:"Europe/Oslo", ...options }).format(dayDate(day));
const displayMoment = (value, options = { dateStyle:"medium", timeStyle:"short" }) => value ? dtf("nb-NO", { timeZone:"Europe/Oslo", ...options }).format(new Date(value)) : "Dato mangler";
const isCalendarTab = (value) => ["overview", "week", "month"].includes(value);
const personColors = new Proxy({}, {get:(_,id)=>memberColor(state?.profile?.members??[],id)});

const profileRequest = async (path, data) => { const response=await fetch(path,data?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}:{}); const result=await response.json(); if(!response.ok)throw Error(result.error||"Kunne ikke lagre profilen.");return result; };
let houseView;
let houseLoading=false;
let profileEditor;
let profileLoading=false;
let state;
const shoppingView=installShoppingView({panel:document.querySelector('#shopping'),banner:document.querySelector('#shopping-banner'),onOpen:()=>setTab('shopping'),onExplore:id=>{setTab('explore');if(id)explorerInstance().then(view=>view.openFamily(id));}});
let explorerReady=null;
const explorerInstance=()=>explorerReady??=import("./library-explorer.mjs?v="+Date.now()).then(({installLibraryExplorer})=>installLibraryExplorer({panel:document.querySelector("#explore")}));
const kiosk = new URLSearchParams(location.search).has("kiosk");
let doorbellView={isOpen:()=>false};
// ?celebrate=tick eller ?celebrate=done viser feiringen med prøvedata (uten å krysse av noe).
{ const preview=new URLSearchParams(location.search).get("celebrate"); if(preview) setTimeout(()=>preview==="done" ? celebrateComplete({ name:"Barn Tre", total:6, color:personColors.child3, homework:true }) : celebrateTick({ x:innerWidth/2, y:innerHeight/2, done:3, total:6, name:"Barn Tre", color:personColors.child3 }), 1500); }
// Older running servers can finish ingestion before the new endpoints deploy.
import('./doorbell-view.mjs').then(({installDoorbellView})=>{doorbellView=installDoorbellView({preview:new URLSearchParams(location.search).get('doorbell-preview'),onFrame:sample=>fetch('/api/doorbell/frame',{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1'},body:JSON.stringify(sample)}).catch(()=>{})});}).catch(()=>{});
if (kiosk) {
  document.body.classList.add("kiosk"); $("#dashboard-home").hidden = false; for (const button of document.querySelectorAll(".return-home")) button.hidden = false;
  // Personfilteret ligger i toppfeltet på stueskjermen, og de tekniske fanene ligger bak «Mer».
  $(".site-header").append($("#person-filter"));
  for (const button of document.querySelectorAll('#tabs [data-tab="archive"], #tabs [data-tab="sources"], #tabs [data-tab="profile"]')) { button.hidden = true; button.dataset.more = "1"; }
  $("#tabs .nav-divider").hidden = true; $("#more-button").hidden = false;
}
let coverage;
let completion;
let sessionMaintenance;
let lastRefresh;
let selectedMember = "all";
let tab = "overview";
let anchorDay = osloDay();
let selectedDay = anchorDay;
let showAllLater = false;
const expandedTasks = new Set();
let hiddenEventsExpanded=false;
const remainingTasks = event => event.task?.items.filter(item=>!item.doneAt).length ?? 0;
function upcomingTasks(member = selectedMember) {
  return Object.values(state.events).filter(event=>event.task && !event.visibility?.hidden && !event.cancelled && remainingTasks(event) && !isExpired(event, osloDay()) && event.task.visibleFrom <= addDays(osloDay(),7) && (member === 'all' || event.members.includes(member)));
}
let renderedDay = osloDay();

function memberName(id) { return state.profile.members.find((member) => member.id === id)?.name ?? id; }
function tag(text, variant = "") { return node("span", text, `tag ${variant}`); }
function empty(message) { return node("div", message, "empty"); }
function linkedText(tagName,text,className) {
  const holder=node(tagName,undefined,className);
  const pattern=/https?:\/\/[^\s<>"\u201d]+/g;
  let cursor=0;
  for (const match of String(text).matchAll(pattern)) {
    const url=match[0].replace(/[.,;!?)\]]+$/g,"");
    holder.append(document.createTextNode(text.slice(cursor,match.index)));
    const anchor=link(url,url); anchor.className="inline-url"; holder.append(anchor);
    cursor=match.index+url.length;
  }
  holder.append(document.createTextNode(text.slice(cursor)));
  return holder;
}
function openExternal(label,href) {
  const holder=prepareDocument();
  holder.append(node("h2",label.replace(" ↗","")),node("p","Nettsiden åpnes under. Enkelte tjenester sperrer innebygd visning eller krever innlogging; lagrede kilder og vedlegg kan leses uten dette.","meta"));
  const frame=node("iframe",undefined,"external-page"); frame.title=label;
  frame.setAttribute("sandbox","allow-scripts allow-same-origin allow-forms");
  frame.referrerPolicy="no-referrer"; frame.src=href;
  holder.append(frame,node("p",href,"source-address"));
  $("#document-dialog").showModal(); holder.scrollTop=0;
}
function link(label, href) {
  const element = node("a", label);
  element.href = href;
  element.target = "_blank";
  element.rel = "noopener noreferrer";
  if (kiosk && /^https?:/i.test(href)) element.onclick = event => {
    event.preventDefault();
    const raw = Object.values(state.rawItems).find(item => item.sourceUrl === href || item.driveUrl === href || item.attachments?.some(file => file.driveUrl === href));
    if (raw) return openRaw(raw);
    const calendarEvent = Object.values(state.events).find(item => item.calendar?.eventUrl === href);
    if (calendarEvent) return openEvent(calendarEvent);
    return openExternal(label,href);
  };
  return element;
}
function prepareDocument() {
  const holder = $("#document-content");
  releaseDocument();
  holder.replaceChildren();
  return holder;
}
function releaseDocument() {
  for (const child of $("#document-content").children) {
    const cleanup=child.cleanup; child.cleanup=null;
    if (!cleanup) continue;
    try { Promise.resolve(cleanup()).catch(error=>console.warn("Dokumentopprydding feilet",error)); }
    catch(error) { console.warn("Dokumentopprydding feilet",error); }
  }
}
function openRaw(raw) {
  const holder = prepareDocument();
  holder.append(node("span",`${raw.source} · ${displayMoment(raw.publishedAt || raw.observedAt,{dateStyle:"medium"})}`,"eyebrow"),node("h2",raw.title));
  holder.append(node("p","Lagret kildekopi · ingen innlogging nødvendig","meta"));
  const split = raw.source === 'renovasjon' ? raw.body?.indexOf('\nJSON:\n') : -1;
  holder.append(linkedText("div",split >= 0 ? raw.body.slice(0,split) : raw.body || "Ingen kildetekst er lagret. Se vedleggene under.","source-body"));
  if (split >= 0) {
    const evidence=node('details');
    evidence.append(node('summary','Vis originalt API-svar'),node('pre',raw.body.slice(split+7),'source-body'));
    holder.append(evidence);
  }
  const attachments = node("div",undefined,"links");
  for (const file of raw.attachments ?? []) attachments.append(attachmentLink(raw,file));
  holder.append(attachments);
  if (raw.sourceUrl) {
    const original=link("Åpne hos kilden ↗",raw.sourceUrl);
    if (kiosk) original.onclick=event=>{event.preventDefault();openExternal(`Original: ${raw.title}`,raw.sourceUrl);};
    holder.append(original);
  }
  $("#document-dialog").showModal();
  holder.scrollTop=0;
}
const sourceLabel=source=>({renovasjon:'Min Renovasjon',vigilo:'Vigilo',spond:'Spond',facebook:'Facebook',telefon:'Telefoninnsending',familie:'Fra familien'})[source]??'Kilde';
function rawLink(raw) {
  const button=node("button",raw.source==='telefon'?'Les uttrekket fra bildet':raw.source==='familie'?'Les familiens melding':`Les ${sourceLabel(raw.source)}-kilden`,"source-button");
  button.type="button"; button.onclick=()=>openRaw(raw); return button;
}
function attachmentLink(raw, attachment) {
  if(attachment.contentError)return node('span',`${attachment.fileName} – originalen er ikke tilgjengelig`,'muted');
  const url = `/api/raw/${raw.id}/attachments/${attachment.id}`;
  const element = link(`${attachment.fileName} ↗`, url);
  if (/\.(pdf|docx|txt|png|jpe?g|webp|gif)$/i.test(attachment.fileName)) element.onclick = async event => {
    event.preventDefault();
    const holder = prepareDocument();
    holder.append(node("h2",attachment.fileName));
    const pdf = /\.pdf$/i.test(attachment.fileName);
    const textDocument=/\.(docx|txt)$/i.test(attachment.fileName);
    const media = node(pdf || textDocument ? "div" : "img");
    if (pdf) media.className="pdf-pages"; else media.src = `${url}?view=1`;
    media.title = attachment.fileName;
    if (media.tagName === "IMG") media.alt = attachment.fileName;
    holder.append(media,link("Last ned original",url));
    if (attachment.driveUrl && !kiosk) holder.append(link("Kopi i Drive ↗",attachment.driveUrl));
    $("#document-dialog").showModal();
    holder.scrollTop=0;
    if (textDocument) {
      media.textContent="Laster dokumentet …";
      try {
        const response=await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let text;
        if (/\.docx$/i.test(attachment.fileName)) {
          await import("/mammoth.browser.js");
          text=(await window.mammoth.extractRawText({arrayBuffer:await response.arrayBuffer()})).value;
        } else text=await response.text();
        if (media.isConnected) media.replaceChildren(linkedText("div",text,"source-body"));
      } catch(error) { media.textContent=`Kunne ikke vise dokumentet: ${error.message}. Bruk Last ned original.`; }
    }
    if (pdf) import("./document-viewer.mjs").then(module=>module.renderPdf(media,url)).then(cleanup=>{if (!$("#document-dialog").open || !media.isConnected) cleanup?.(); else media.cleanup=cleanup;});
  };
  return element;
}
function card(title, subtitle) {
  const element = node("article", undefined, "card");
  const header = node("header");
  header.append(node("h3", title), node("span", subtitle, "meta"));
  element.append(header);
  return element;
}
function dots(members) {
  const holder = node("span", undefined, "person-dots");
  for (const id of members ?? []) {
    const dot = node("span", undefined, "person-dot");
    dot.style.backgroundColor = personColors[id] ?? "#a5aaa4";
    dot.title = memberName(id);
    holder.append(dot);
  }
  return holder;
}
function filteredEvents() {
  return Object.values(state.events).filter((event) => !event.visibility?.hidden && (selectedMember === "all" || event.members.includes(selectedMember)));
}
function visibilityButton(event) {
  const button=node('button',event.visibility?.hidden ? 'Gjenåpne oppføring' : 'Ferdig vurdert · skjul','source-button visibility-button');
  button.type='button';
  if (event.taskSplit) {button.textContent='Erstattet av personlige lekseoppgaver';button.disabled=true;return button;}
  button.onclick=async()=>{
    button.disabled=true;
    try {
      const response=await fetch(`/api/events/${event.id}/visibility`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hidden:!event.visibility?.hidden})});
      const updated=await response.json();if(!response.ok)throw Error(updated.error);
      state.events[event.id]=updated;
      $('#event-dialog').close();renderPeople();render();
    } catch(error){alert(`Kunne ikke lagre: ${error.message}`);button.disabled=false;}
  };
  return button;
}
// Felles avkrysning for sjekklisten og forsiden. Feiringen starter før lagringen;
// full fest bare når en hel lekseliste blir ferdig, ellers en liten fest.
async function toggleTaskItem(event, item, done, { anchor, pulse } = {}) {
  const feast = celebrationFor({ items: event.task.items, key: item.key, checked: done });
  if (feast) {
    const member = event.members?.length === 1 ? event.members[0] : null;
    const who = { name: member ? memberName(member) : '', color: member ? personColors[member] : undefined };
    pop(pulse);
    if (feast.complete && isHomework(event)) celebrateComplete({ ...who, total: feast.total, homework: true, title: cleanTitle(event.title) });
    else { const rect = anchor?.getBoundingClientRect(); celebrateTick({ ...who, x: rect ? rect.left + rect.width / 2 : innerWidth / 2, y: rect ? rect.top : innerHeight / 2, done: feast.done, total: feast.total }); }
  }
  const response = await fetch(`/api/events/${event.id}/tasks/${item.key}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({done,expectedText:item.text})});
  if (!response.ok) throw new Error((await response.json()).error);
  const updated = await response.json();
  state.events[event.id] = updated;
  renderPeople();
  render();
  if ($("#event-dialog").open) openEvent(updated);
  return updated;
}
function taskChecklist(event) {
  const list = node("div",undefined,"task-checklist");
  for (const item of event.task.items) {
    const label = node("label",undefined,item.doneAt ? "task-item done" : "task-item");
    const input = node("input"); input.type = "checkbox"; input.checked = !!item.doneAt;
    input.disabled = !!event.taskSplit;
    input.onchange = async () => {
      input.disabled = true;
      try {
        await toggleTaskItem(event, item, input.checked, { anchor: input, pulse: label });
      } catch (error) { input.checked = !!item.doneAt; alert(`Kunne ikke lagre avkryssingen: ${error.message}`); }
      finally { input.disabled = false; }
    };
    label.append(input,node("span",item.text)); list.append(label);
  }
  return list;
}
function taskCard(event) {
  const done = event.task.items.filter(item=>item.doneAt).length;
  const element = node('details',undefined,'card task-group');
  element.open=expandedTasks.has(event.id);
  element.ontoggle=()=>{ if (element.isConnected) { if(element.open) expandedTasks.add(event.id); else expandedTasks.delete(event.id); } };
  const heading=node('summary',undefined,'task-group-heading');
  heading.append(node('strong',cleanTitle(event.title)),node('span',`${remainingTasks(event)} igjen · frist ${displayDay(event.task.dueDate,{weekday:'short',day:'numeric',month:'short'})}${event.task.dueDate < osloDay() && remainingTasks(event) ? ' · Fristen er passert' : ''}`,'meta'));
  element.append(heading);
  const overdue = event.task.dueDate < osloDay() && done < event.task.items.length;
  const progress=node('span',undefined,'k-progress');const fill=node('i');fill.style.width=`${event.task.items.length ? Math.round(done/event.task.items.length*100) : 0}%`;progress.append(fill);heading.append(progress);
  element.append(node("p",`${event.members.map(memberName).join(" · ")} · ${displayDay(event.task.visibleFrom,{day:"numeric",month:"short"})}–${displayDay(event.task.dueDate,{day:"numeric",month:"short"})}${overdue ? " · Fristen er passert" : ""}`,"meta"));
  element.append(taskChecklist(event));
  const details = node("button","Detaljer og kilder ↗","show-more"); details.onclick=()=>openEvent(event); element.append(details);
  return element;
}
function renderTasks() {
  const holder = $("#task-list"); holder.replaceChildren();
  $('#tasks h2').textContent=selectedMember==='all' ? 'Familiens oppgaver' : `Oppgaver · ${memberName(selectedMember)}`;
  const tasks = filteredEvents().filter(event=>event.task && !event.cancelled).sort((a,b)=>a.task.dueDate.localeCompare(b.task.dueDate));
  const active = tasks.filter(event=>event.task.items.some(item=>!item.doneAt));
  if (!active.length) holder.append(empty("Ingen uferdige oppgaver."));
  const near=active.filter(event=>event.task.visibleFrom<=addDays(osloDay(),7));
  for (const event of near) holder.append(taskCard(event));
  const future=active.filter(event=>!near.includes(event));
  if(future.length) { const later=node('details',undefined,'completed-tasks future-tasks'); later.append(node('summary',`Senere (${future.length} oppgavegrupper)`)); for(const event of future) later.append(taskCard(event)); holder.append(later); }
  const done = tasks.filter(event=>event.task.items.every(item=>item.doneAt));
  if (done.length) { const history=node("details",undefined,"completed-tasks"); history.append(node("summary",`Fullført (${done.length})`)); for(const event of done) history.append(taskCard(event)); holder.append(history); }
  const hidden=Object.values(state.events).filter(event=>event.visibility?.hidden && (selectedMember==='all'||event.members.includes(selectedMember)));
  const archive=node('details',undefined,'completed-tasks hidden-events');
  archive.open=hiddenEventsExpanded;
  archive.ontoggle=()=>{hiddenEventsExpanded=archive.open;};
  archive.append(node('summary',`Skjulte oppføringer (${hidden.length})`));
  for(const event of hidden)archive.append(eventRow(event,eventStartDay(event),true));
  if(!hidden.length)archive.append(empty('Ingen skjulte oppføringer.'));
  holder.append(archive);
}
function eventTime(event, day) {
  if (event.task) return `${event.task.items.filter(item=>item.doneAt).length}/${event.task.items.length} gjort`;
  if (event.allDay) return "Hele dagen";
  if (isFollowUp(event)) return "Følg opp";
  if (eventStartDay(event) !== day) return "Pågår";
  return displayMoment(event.start, { hour:"2-digit", minute:"2-digit" });
}
function summary(event) {
  const text = event.checklist?.[0] || event.details?.split("\n").find(Boolean) || "";
  return text.length > 110 ? `${text.slice(0, 107).trimEnd()}…` : text;
}
function openEvent(event, day = eventStartDay(event)) {
  const holder = $("#dialog-content");
  holder.replaceChildren();
  holder.append(node("span", "Familiekalender", "eyebrow"), node("h2", cleanTitle(event.title)));
  const when = node("p", `${displayDay(day, { weekday:"long", day:"numeric", month:"long", year:"numeric" })} · ${eventTime(event, day)}`, "dialog-when");
  holder.append(when);
  const people = node("div", undefined, "dialog-people");
  people.append(dots(event.members), node("span", event.members.length ? event.members.map(memberName).join(" · ") : "Hele familien"));
  if (event.provisional) people.append(tag("Foreløpig dato", "warn"));
  if (event.cancelled) people.append(tag("Avlyst", "warn"));
  holder.append(people);
  const sync=event.visibility?.sync;
  holder.append(visibilityButton(event),node('p',sync?.error ? `Kalenderendringen venter: ${sync.error}` : sync?.status==='pending' ? 'Luna synkroniserer endringen med Google-kalenderen.' : event.visibility?.hidden ? 'Skjult fra dashboardet og fjernet fra Google-kalenderen. Originalene er bevart.' : 'Fjerner fra dashboardet og Google-kalenderen. Gjenåpne under Oppgaver → Skjulte oppføringer for å legge tilbake. Originalene beholdes.','meta visibility-help'));
  if (event.timeNote) holder.append(node('p',event.timeNote,'meta'));
  if (event.details) holder.append(linkedText("p", event.details, "dialog-details"));
  if (event.reason) holder.append(node("p", event.reason, "dialog-reason"));
  if (event.task) { holder.append(node("h3","Kryss av når det er gjort","dialog-subheading"), taskChecklist(event)); }
  else if (event.checklist?.length) {
    holder.append(node("h3", "Husk dette", "dialog-subheading"));
    const list = node("ul", undefined, "checklist");
    for (const item of event.checklist) list.append(node("li", item));
    holder.append(list);
  }
  const links = node("div", undefined, "links dialog-links");
  const seen = new Set();
  const addLink = (label, url) => { if (url && !seen.has(url)) { links.append(link(label, url)); seen.add(url); } };
  if (!kiosk && !event.calendar?.removedAt) addLink("Åpne i familiekalenderen ↗", event.calendar?.eventUrl);
  for (const rawId of event.sourceRefs ?? []) {
    const raw = state.rawItems[rawId];
    if (!raw) continue;
    const originals=raw.attachments??[];
    if(raw.source==='telefon'&&originals.length){
      for(const attachment of originals)links.append(attachmentLink(raw,attachment));
      const extracted=node('details');extracted.append(node('summary','Uttrekk og kildeinformasjon'),rawLink(raw));
      if(!kiosk)addLink('Kildekort i Drive ↗',raw.driveUrl);
      links.append(extracted);continue;
    }
    links.append(rawLink(raw));
    if (!kiosk) {
      addLink(`${sourceLabel(raw.source)}: original ↗`, raw.sourceUrl);
      addLink("Rådata i Drive ↗", raw.driveUrl);
    }
    for (const attachment of raw.attachments ?? []) links.append(attachmentLink(raw,attachment));
  }
  if (links.childElementCount) holder.append(node("h3", "Kilder", "dialog-subheading"), links);
  $("#event-dialog").showModal();
}
function eventRow(event, day, compact = false) {
  const button = node("button", undefined, `event-row${compact ? " compact" : ""}`);
  button.type = "button";
  button.setAttribute("aria-label", `Vis ${event.title}, ${displayDay(day, { day:"numeric", month:"long" })}`);
  button.append(node("span", eventTime(event, day), "event-time"));
  const middle = node("span", undefined, "event-main");
  const titleLine = node("span", undefined, "event-title-line");
  titleLine.append(dots(event.members), node("strong", cleanTitle(event.title)));
  if (event.provisional) titleLine.append(node("span", "Foreløpig", "event-provisional"));
  if (event.cancelled) titleLine.append(node("span", "Avlyst", "event-provisional"));
  middle.append(titleLine);
  const note = summary(event);
  if (note) middle.append(node("span", note, "event-note"));
  button.append(middle, node("span", "↗", "event-open"));
  button.onclick = () => openEvent(event, day);
  return button;
}
function eventChip(event, day) {
  const button = node("button", undefined, "event-chip");
  button.type = "button";
  button.style.setProperty("--chip-color", personColors[event.members?.[0]] ?? "#9aa49a");
  const label = event.allDay ? "" : `${eventTime(event, day)}${isFollowUp(event) ? ": " : " "}`;
  button.textContent = `${label}${cleanTitle(event.title)}`;
  if (isFollowUp(event)) button.classList.add("is-followup");
  button.title = event.title;
  button.onclick = () => openEvent(event, day);
  return button;
}
function dayPanel(label, day, events, compact = false) {
  const panel = node("section", undefined, `day-panel${compact ? " mini" : ""}`);
  panel.dataset.scrollKey = day;
  const header = node("div", undefined, "day-panel-header");
  header.append(node("h3", label), node("span", displayDay(day, { weekday:"long", day:"numeric", month:"long" }), "day-panel-date"));
  panel.append(header);
  const list = node("div", undefined, "agenda-list");
  const matches = eventsOnDay(events, day);
  if (matches.length) for (const event of matches) list.append(eventRow(event, day, compact));
  else list.append(empty("Ingen planer registrert."));
  panel.append(list);
  return panel;
}
function renderClock() {
  const now = new Date(kiosk ? kioskHome.displayNow() : Date.now());
  if (kiosk) kioskHome.tick();
  $("#current-date").textContent = dtf("nb-NO", { timeZone:"Europe/Oslo", weekday:"long", day:"numeric", month:"long" }).format(now);
  $("#clock").textContent = dtf("nb-NO", { timeZone:"Europe/Oslo", hour:"2-digit", minute:"2-digit" }).format(now);
}
function renderWeeklyLetter() {
  const holder = $('#weekly-letter');
  const child = state.profile.members.find(member => member.id === selectedMember && member.role === 'child');
  holder.hidden = !child || !(isCalendarTab(tab) || tab === 'tasks');
  holder.replaceChildren();
  if (holder.hidden) return;
  const letter = (state.weeklyLetters ?? []).find(item => item.memberId === selectedMember);
  if (!letter) { holder.append(node('span', `Ukebrev for ${child.name} · ikke tilgjengelig ennå`, 'meta')); return; }
  const raw = state.rawItems[letter.rawId];
  if (!raw) return;
  const file = raw.attachments?.find(item => item.id === letter.attachmentId);
  const button = file ? attachmentLink(raw, file) : rawLink(raw);
  button.className = 'weekly-letter-button';
  button.replaceChildren(node('span', '▤', 'weekly-letter-icon'), node('strong', `Ukebrev · uke ${letter.week}`), node('span', 'Åpne →'));
  button.setAttribute('aria-label', `Åpne ukebrevet for ${child.name}, uke ${letter.week}, ${letter.year}`);
  holder.append(button);
  if (letter.status !== 'current') holder.append(node('span', letter.status === 'upcoming' ? 'Neste skoleuke' : 'Sist tilgjengelig', 'weekly-letter-note'));
}
function renderPeople() {
  const holder = $("#person-filter");
  holder.replaceChildren();
  for (const member of [{ id:"all", name:"Alle" }, ...state.profile.members.filter((person) => person.role === "child"), ...state.profile.members.filter((person) => person.role !== "child")]) {
    const group=node('div',undefined,`person-controls${selectedMember === member.id ? ' is-selected' : ''}`);
    const button = node("button", undefined, selectedMember === member.id ? "active" : "");
    button.type = "button";
    button.setAttribute("aria-pressed", selectedMember === member.id ? "true" : "false");
    if (member.id !== "all") button.append(dots([member.id]));
    button.append(node("span", member.name));
    button.onclick = () => {
      selectedMember = member.id;
      if (tab === 'tasks') for (const event of upcomingTasks(member.id)) expandedTasks.add(event.id);
      renderPeople(); render();
    };
    group.append(button);
    const tasks=upcomingTasks(member.id);
    const count=tasks.reduce((sum,event)=>sum+remainingTasks(event),0);
    const urgent=tasks.some(event=>event.task.visibleFrom<=osloDay() && event.task.dueDate<=osloDay());
    const expand=node('button',kiosk ? String(count) : `☑ ${count}`,`person-tasks${urgent ? ' has-deadline' : ''}`);
    if (kiosk && !count) expand.hidden=true;
    expand.type='button';
    expand.setAttribute('aria-label',`Vis oppgaver for ${member.name}: ${count} gjenstående${urgent ? ', frist i dag eller passert' : ''}`);
    if (!kiosk) expand.title=`${count} gjenstående deloppgaver som har startet eller starter de neste 7 dagene${urgent ? '. Noen har frist i dag eller er forsinket.' : ''}`;
    expand.onclick=()=>{
      selectedMember=member.id;
      for (const event of upcomingTasks(member.id)) expandedTasks.add(event.id);
      renderPeople(); setTab('tasks');
    };
    group.append(expand); holder.append(group);
  }
}
function renderWeekStrip(events) {
  const holder = $("#week-strip");
  holder.replaceChildren();
  const today = osloDay();
  for (const day of weekDays(today)) {
    const button = node("button", undefined, `strip-day${day === today ? " today" : ""}`);
    button.type = "button";
    button.append(node("span", displayDay(day, { weekday:"short" }), "strip-weekday"), node("strong", displayDay(day, { day:"numeric" })));
    const count = eventsOnDay(events, day).length;
    button.append(node("span", count ? `${count} ${count === 1 ? "plan" : "planer"}` : "", "strip-count"));
    button.onclick = () => { anchorDay = day; selectedDay = day; setTab("week"); };
    holder.append(button);
  }
}
function kioskContext(events) {
  return { events, node, dots, displayDay, eventsOnDay, eventStartDay, addDays, osloDay, openEvent, setTab, upcomingTasks, activityChoices,
    allTasks: () => Object.values(state.events).filter((event) => event.task && !event.visibility?.hidden && !event.cancelled && (selectedMember === 'all' || event.members.includes(selectedMember))),
    children: () => state.profile.members.filter((member) => member.role === 'child' && (selectedMember === 'all' || member.id === selectedMember)),
    toggleTask: toggleTaskItem };
}
function renderOverview(events) {
  if (kiosk) return kioskHome.render(kioskContext(events));
  const today = osloDay();
  const tomorrow = addDays(today, 1);
  const laterFrom = addDays(today, 2);
  const holder = node("div", undefined, "overview");
  const mainDays = node("div", undefined, "overview-days");
  const appointments=events.filter(event=>!event.task);
  mainDays.append(dayPanel("I dag", today, appointments), dayPanel("I morgen", tomorrow, appointments));
  holder.append(mainDays);
  // Surface deadlines through the next two days on the main dashboard. This
  // keeps already-recorded and newly added tasks visible before their due day.
  const taskDeadlineThrough = addDays(today, 2);
  const tasks = upcomingTasks().filter(event=>event.task.visibleFrom<=today && event.task.dueDate<=taskDeadlineThrough).sort((a,b)=>a.task.dueDate.localeCompare(b.task.dueDate));
  if (tasks.length) {
    const panel=node('section',undefined,'overview-tasks'); panel.append(node('h3','Oppgaver med frist snart'), node('p','Frister i dag og de neste to dagene','meta'));
    for (const event of tasks.slice(0,3)) {
      const row=eventRow(event,today,true);
      const due=displayDay(event.task.dueDate,{weekday:'long',day:'numeric',month:'long'});
      row.setAttribute('aria-label',`Åpne oppgaven ${event.title}, frist ${due}, ${remainingTasks(event)} gjenstående`);
      row.querySelector('.event-main').append(node('span',`Frist: ${due}`,'event-task-deadline'));
      panel.append(row);
    }
    const more=node('button',`Vis alle oppgaver (${tasks.reduce((n,e)=>n+remainingTasks(e),0)} åpne med frist snart) →`,'show-more'); more.onclick=()=>setTab('tasks'); panel.append(more);
    (kiosk ? mainDays.firstElementChild : holder).append(panel);
  }
  const later = node("section", undefined, "later-panel");
  later.dataset.scrollKey="later";
  const heading = node("div", undefined, "later-header");
  heading.append(node("h3", "Senere"), node("span", "Det som kommer", "meta"));
  later.append(heading);
  const upcoming = appointments.filter((event) => eventStartDay(event) >= laterFrom).sort((a, b) => eventStartDay(a).localeCompare(eventStartDay(b)) || Date.parse(a.start) - Date.parse(b.start));
  const visible = showAllLater ? upcoming : upcoming.slice(0, 12);
  if (!visible.length) later.append(empty("Ingen senere planer registrert."));
  for (const event of visible) {
    const day = eventStartDay(event);
    const row = eventRow(event, day);
    row.prepend(node("span", displayDay(day, { weekday:"short", day:"numeric", month:"short" }), "later-date"));
    later.append(row);
  }
  if (upcoming.length > 12) {
    const toggle = node("button", showAllLater ? "Vis færre" : `Vis alle ${upcoming.length} planer →`, "show-more");
    toggle.type = "button";
    toggle.onclick = () => { showAllLater = !showAllLater; render(); };
    later.append(toggle);
  }
  holder.append(later);
  const suggestions=activityChoices(true).slice(0,2);
  if (suggestions.length) {
    const teaser=node('section',undefined,'nearby-teaser');
    const button=node('button','Hva skjer rundt oss? →','show-more');button.onclick=()=>setTab('nearby');
    teaser.append(button,node('p',suggestions.map(item=>item.title).join(' · '),'meta'));
    mainDays.firstElementChild.append(teaser);
  }
  return holder;
}
function activityChoices(preview=false) {
  const window=preview?'30':$('#nearby-window').value;
  let from=osloDay(), to=addDays(from,Number(window)||30);
  if (window==='weekend') {
    const weekday=dayDate(from).getUTCDay(); from=addDays(from,(5-weekday+7)%7); to=addDays(from,2);
  }
  const filter=preview?'all':$('#nearby-filter').value;
  return Object.values(state.activities??{}).filter(item=>!item.mergedInto && !item.cancelled && Date.parse(item.end)>Date.now() && eventStartDay(item)<=to && osloDay(new Date(item.end))>=from && (selectedMember==='all'||item.members.includes(selectedMember)) && (filter==='hidden'?item.reaction==='hidden':item.reaction!=='hidden') && (filter!=='free'||item.free) && (filter!=='saved'||item.reaction==='interested'||item.plan)).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start) || (b.reaction==='interested')-(a.reaction==='interested') || b.score-a.score || a.title.localeCompare(b.title,'nb'));
}
function activityState(item) {
  if (item.plan?.status==='published') return 'I familiekalenderen';
  if (item.plan?.status==='blocked') return 'Kalenderføring trenger avklaring';
  if (item.plan) return 'Valgt – venter på kalenderføring';
  return item.reaction==='interested'?'♥ Interessert':'Forslag';
}
async function reactActivity(item,action) {
  const response=await fetch(`/api/activities/${item.id}/reaction`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
  const result=await response.json();
  if (!response.ok) throw new Error(result.error??'Kunne ikke lagre valget.');
  if(item.id!==result.id) delete state.activities[item.id];state.activities[result.id]=result;render();return result;
}
function openActivity(item) {
  item=state.activities[item.id];
  const holder=$('#dialog-content');holder.replaceChildren();
  holder.append(node('span',`${item.category} · ${activityState(item)}`,'eyebrow'),node('h2',item.title),node('p',`${displayMoment(item.start)} – ${displayMoment(item.end,{timeStyle:'short'})}`,'event-date'),node('p',item.location,'meta'));
  const people=node('div',undefined,'tags');for(const id of item.members) people.append(tag(memberName(id)));holder.append(people);
  if (item.pitch) holder.append(node('p',item.pitch,'activity-pitch-detail'));
  if (item.summary && item.summary!==item.pitch) holder.append(node('p',item.summary));
  holder.append(node('h3','Hvorfor dette for oss?'),node('p',item.reason));
  for(const [label,value] of [['Passer for',item.audience],['Pris',item.price],['Påmelding',item.registration],['Praktisk',item.practical]]) if(value) holder.append(node('h3',label),node('p',value));
  const actions=node('div',undefined,'activity-actions'), message=node('p',undefined,'meta');message.setAttribute('role','status');
  const actionButton=(label,action)=>{
    const button=node('button',label,'source-button');button.onclick=async()=>{button.disabled=true;try {const updated=await reactActivity(item,action); if(action==='hidden') $('#event-dialog').close();else openActivity(updated);} catch(error){message.textContent=error.message;button.disabled=false;}};actions.append(button);
  };
  actionButton(item.reaction==='interested'?'Fjern interesse':'♥ Interessert',item.reaction==='interested'?'restore':'interested');
  actionButton(item.reaction==='hidden'?'Vis igjen':'Skjul forslaget',item.reaction==='hidden'?'restore':'hidden');
  if (!item.plan) actionButton('Velg til familiekalenderen','plan');
  else if (item.plan.status!=='published') actionButton('Angre kalendervalg','cancel-plan');
  else {const button=node('button','Åpne kalenderavtalen','source-button');button.onclick=()=>openEvent(state.events[item.plan.eventId]);actions.append(button);}
  holder.append(actions,message);
  if (item.plan?.status==='blocked') holder.append(node('p',item.plan.details,'warning'));
  holder.append(node('p',item.plan?.status==='published'?'Avtalen er lagt i familiekalenderen.':'Et kalendervalg behandles ved neste planlagte gjennomgang. Påmelding eller kjøp må dere gjøre hos arrangøren.','meta'));
  const evidence=node('details');evidence.append(node('summary','Les lagret kildebelegg'),node('p',item.evidence,'source-body'));holder.append(evidence);
  holder.append(node('p',`Kilde kontrollert ${displayMoment(item.checkedAt)}. Ledige plasser kan endre seg.`,'meta'),link('Åpne arrangørens side ↗',item.sourceUrl));
  if (!$('#event-dialog').open) $('#event-dialog').showModal();holder.scrollTop=0;
}
function renderNearby() {
  const holder=$('#nearby-list');holder.replaceChildren();const items=activityChoices();
  for (const button of document.querySelectorAll('[data-nearby-window]')) button.setAttribute('aria-pressed',String(button.dataset.nearbyWindow===$('#nearby-window').value));
  for (const button of document.querySelectorAll('[data-nearby-filter]')) button.setAttribute('aria-pressed',String(button.dataset.nearbyFilter===$('#nearby-filter').value));
  $('#nearby-count').textContent=`${items.length} forslag`;
  if (!items.length) holder.append(empty('Ingen forslag med disse filtrene akkurat nå.'));
  for(const item of items) {
    const card=node('article',undefined,'activity-card');
    card.append(node('span',`${item.category} · ${displayMoment(item.start,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`,'eyebrow'),node('h3',item.title),node('p',item.location,'meta'),node('p',item.pitch || item.summary || item.reason,'activity-pitch'));
    const tags=node('div',undefined,'tags');for(const id of item.members) tags.append(tag(memberName(id)));tags.append(tag(item.price));card.append(tags);
    if (item.reaction || item.plan) card.append(node('p',activityState(item),'activity-choice'));
    if (Date.now()-Date.parse(item.checkedAt)>7*86400000) card.append(node('p','Kilden må kontrolleres på nytt','warning'));
    const button=node('button','Se forslag →','source-button');button.onclick=()=>openActivity(item);card.append(button);holder.append(card);
  }
  const sources=$('#nearby-sources');sources.replaceChildren();
  const statuses=Object.values(state.activitySourceStatus??{});
  if(!statuses.length) sources.append(empty('Aktivitetskildene er ennå ikke gjennomgått.'));
  for(const source of statuses) sources.append(node('p',`${source.sourceId} · ${source.health==='ok'?'Kontrollert':source.health==='needs_login'?'Trenger innlogging':source.health==='error'?'Feil':'Delvis gjennomgått'} · ${displayMoment(source.checkedAt)} — ${source.details}`,'meta'));
}
function focusRail(events) {
  const rail = node("aside", undefined, "focus-rail");
  const today = osloDay();
  rail.append(dayPanel("I dag", today, events, true), dayPanel("I morgen", addDays(today, 1), events, true));
  return rail;
}
function dayDetail(events) {
  const detail = node("section", undefined, "selected-day");
  detail.append(node("h3", displayDay(selectedDay, { weekday:"long", day:"numeric", month:"long" })));
  const matches = eventsOnDay(events, selectedDay);
  if (!matches.length) detail.append(empty("Ingen planer denne dagen."));
  else for (const event of matches) detail.append(eventRow(event, selectedDay, true));
  return detail;
}
function taskBand(days) {
  const first=days[0], last=days.at(-1);
  const tasks=upcomingTasks().filter(event=>event.task.visibleFrom<=last && event.task.dueDate>=first).sort((a,b)=>a.task.dueDate.localeCompare(b.task.dueDate));
  const band=node('div',undefined,'week-tasks');
  for (const event of tasks) {
    const button=node('button',undefined,'week-task'); button.type='button';
    const done=event.task.items.filter(item=>item.doneAt).length;
    button.append(dots(event.members),node('strong',cleanTitle(event.title)),node('span',`${done}/${event.task.items.length} · frist ${displayDay(event.task.dueDate,{weekday:'short',day:'numeric',month:'short'})}`,'meta'));
    button.onclick=()=>openEvent(event);
    band.append(button);
  }
  return tasks.length ? band : null;
}
function renderWeek(events) {
  const layout = node("div", undefined, "calendar-layout");
  const days = weekDays(anchorDay);
  // Stueskjermen viser oppgavene én gang som bånd øverst, ikke som gjentatte rader hver dag.
  const cellEvents = kiosk ? events.filter(event => !event.task && !isWaste(event)) : events;
  if (!kiosk) layout.append(focusRail(events));
  const body = node("div", undefined, "calendar-body");
  if (kiosk) { const band=taskBand(days); if (band) body.append(band); }
  const grid = node("div", undefined, "week-grid");
  for (const day of days) {
    const cell = node("section", undefined, `week-cell${day === osloDay() ? " is-today" : ""}${day < osloDay() ? " is-past" : ""}`);
    const heading = node("button", undefined, "calendar-day-heading");
    heading.type = "button";
    heading.append(node("span", displayDay(day, { weekday:"short" })), node("strong", displayDay(day, { day:"numeric" })));
    heading.onclick = () => { selectedDay = day; renderCalendar(); };
    cell.append(heading);
    for (const event of eventsOnDay(cellEvents, day)) cell.append(eventChip(event, day));
    if (kiosk) for (const event of upcomingTasks().filter(item=>item.task.dueDate===day)) { const due=node('button',`Frist: ${cleanTitle(event.title)}`,'event-chip due-chip'); due.type='button'; due.onclick=()=>openEvent(event); cell.append(due); }
    grid.append(cell);
  }
  body.append(grid);
  if (!kiosk || selectedDay !== osloDay()) body.append(dayDetail(cellEvents));
  layout.append(body);
  return layout;
}
function renderMonth(events) {
  const layout = node("div", undefined, "calendar-layout");
  const cellEvents = kiosk ? events.filter(event => !event.task && !isWaste(event)) : events;
  if (!kiosk) layout.append(focusRail(events));
  const body = node("div", undefined, "calendar-body");
  const weekdays = node("div", undefined, "month-weekdays");
  for (const day of weekDays(osloDay())) weekdays.append(node("span", displayDay(day, { weekday:"short" })));
  body.append(weekdays);
  const grid = node("div", undefined, "month-grid");
  // Stueskjermen viser fem rullerende uker fra valgt uke, slik at i dag alltid er øverst.
  const days = kiosk ? Array.from({ length:35 }, (_, index) => addDays(mondayOf(anchorDay), index)) : monthDays(anchorDay);
  const limit = kiosk ? 4 : 3;
  for (const day of days) {
    const outside = !kiosk && day.slice(0, 7) !== anchorDay.slice(0, 7);
    const cell = node("div", undefined, `month-cell${outside ? " outside-month" : ""}${day === osloDay() ? " is-today" : ""}${day < osloDay() && kiosk ? " is-past" : ""}${day === selectedDay && !(kiosk && day === osloDay()) ? " selected" : ""}`);
    const number = node("button", kiosk && (day.endsWith("-01") || day === days[0]) ? displayDay(day, { day:"numeric", month:"short" }) : displayDay(day, { day:"numeric" }), "month-day-number");
    number.type = "button";
    number.setAttribute("aria-label", displayDay(day, { weekday:"long", day:"numeric", month:"long" }));
    number.onclick = () => { selectedDay = day; renderCalendar(); };
    cell.append(number);
    const matches = eventsOnDay(cellEvents, day);
    cell.dataset.count = String(matches.length);
    if (matches.length) cell.classList.add("has-events");
    for (const event of matches.slice(0, limit)) cell.append(eventChip(event, day));
    if (matches.length > limit) {
      const more = node("button", `+${matches.length - limit} til`, "month-more");
      more.type = "button";
      more.onclick = () => { selectedDay = day; renderCalendar(); $(".selected-day")?.scrollIntoView({ behavior:"smooth", block:"nearest" }); };
      cell.append(more);
    }
    grid.append(cell);
  }
  body.append(grid);
  if (!kiosk || selectedDay !== osloDay()) body.append(dayDetail(cellEvents));
  layout.append(body);
  return layout;
}
function renderCalendar() {
  const events = filteredEvents();
  const today = osloDay();
  $("#period-controls").hidden = tab === "overview";
  $("#week-strip").hidden = tab !== "overview";
  $("#view-kicker").textContent = tab === "overview" ? "Oversikt" : tab === "week" ? "Ukevisning" : "Månedsvisning";
  if (tab === "overview") $("#view-title").textContent = "I dag og fremover";
  if (tab === "week") {
    const days = weekDays(anchorDay);
    $("#view-title").textContent = `${displayDay(days[0], { day:"numeric", month:"short" })} – ${displayDay(days[6], { day:"numeric", month:"short", year:"numeric" })}`;
  }
  if (tab === "month") $("#view-title").textContent = kiosk ? `${displayDay(mondayOf(anchorDay), { day:"numeric", month:"short" })} – ${displayDay(addDays(mondayOf(anchorDay), 34), { day:"numeric", month:"short", year:"numeric" })}` : displayDay(`${anchorDay.slice(0, 7)}-01`, { month:"long", year:"numeric" });
  $("#current-period").disabled = tab === "week" || (kiosk && tab === "month") ? mondayOf(anchorDay) === mondayOf(today) : anchorDay.slice(0, 7) === today.slice(0, 7);
  renderWeekStrip(events);
  const holder = $("#calendar-content");
  holder.replaceChildren(tab === "overview" ? renderOverview(events) : tab === "week" ? renderWeek(events) : renderMonth(events));
  if (kiosk && tab === "overview") kioskHome.fitAll();
}
function renderArchive() {
  const holder = $("#raw-list");
  holder.replaceChildren();
  const search = $("#search").value.trim().toLocaleLowerCase("nb-NO");
  const source = $("#source-filter").value;
  const items = Object.values(state.rawItems).filter((item) =>
    (!source || item.source === source) &&
    (selectedMember === "all" || item.memberIds.includes(selectedMember)) &&
    (!search || `${item.title} ${item.body} ${item.groupName ?? ""}`.toLocaleLowerCase("nb-NO").includes(search))
  ).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  if (!items.length) return holder.append(empty("Ingen rådata matcher søket."));
  for (const item of items) {
    const subtitle = `${item.source} · ${item.publishedAt ? displayMoment(item.publishedAt, { dateStyle:"medium" }) : displayMoment(item.observedAt, { dateStyle:"medium" })}`;
    const element = card(item.title, subtitle);
    if (item.body) element.append(linkedText("p", item.body.slice(0, 1200)));
    const tags = node("div", undefined, "tags");
    for (const id of item.memberIds) tags.append(tag(memberName(id)));
    tags.append(tag(`Revisjon ${item.revision}`));
    element.append(tags);
    const links = node("div", undefined, "links");
    links.append(rawLink(item));
    if (item.sourceUrl && !kiosk) links.append(link("Åpne original ↗", item.sourceUrl));
    if (item.driveUrl && !kiosk) links.append(link("Kopi i Drive ↗", item.driveUrl));
    for (const attachment of item.attachments) links.append(attachmentLink(item,attachment));
    element.append(links);
    holder.append(element);
  }
}
const millions = (value) => `${(value / 1e6).toFixed(1)} M`;
async function renderUsage() {
  const holder = $("#usage-list");
  try {
    const response = await fetch("/api/usage?days=7");
    if (!response.ok) throw new Error();
    const usage = await response.json();
    holder.replaceChildren();
    const totals = usage.totals;
    const cachedShare = totals.inputTokens ? Math.round((1 - totals.uncachedInputTokens / totals.inputTokens) * 100) : 0;
    holder.append(node("p", `Siste 7 dager: ${totals.sessions} kjøringer · ${totals.turns} runder · ${totals.toolCalls} verktøykall · ${millions(totals.inputTokens)} input (${cachedShare} % fra cache) · ${Math.round(totals.outputTokens / 1000)} k output`, "meta"));
    const table = node("table", undefined, "usage");
    const head = node("tr"); for (const label of ["Start", "Type", "Min", "Runder", "Verktøykall", "Input", "Ny input", "Output", "Kontekst"]) head.append(node("th", label)); table.append(head);
    for (const item of usage.sessions.slice(0, 12)) {
      const row = node("tr");
      for (const value of [displayMoment(item.startedAt, { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }), item.kind, item.minutes ?? "", item.turns, item.toolCalls, millions(item.inputTokens), millions(item.uncachedInputTokens), `${Math.round(item.outputTokens / 1000)} k`, `${Math.round(item.contextPeak / 1000)} k`]) row.append(node("td", String(value)));
      table.append(row);
    }
    holder.append(table);
  } catch { holder.replaceChildren(node("p", "Kostnadstall er ikke tilgjengelige akkurat nå.", "meta")); }
}
function renderSources() {
  renderUsage();
  const holder = $("#source-list");
  holder.replaceChildren();
  if (sessionMaintenance) {
    const status = card("Vigilo-øktkontroll",sessionMaintenance.checkedAt ? displayMoment(sessionMaintenance.checkedAt) : "Venter på aktivert Chrome-utvidelse");
    status.append(node("p",sessionMaintenance.details));
    if (sessionMaintenance.stale) status.append(tag("Øktkontrollen svarer ikke", "warn"));
    else if (sessionMaintenance.health === "needs_login") status.append(tag("Innlogging kreves", "warn"));
    else if (sessionMaintenance.health === "error") status.append(tag("Økten er ikke bekreftet", "warn"));
    if (sessionMaintenance.upgradeRequired) status.append(tag("Last inn utvidelse 1.2.0 i Chrome", "warn"));
    if (sessionMaintenance.lastAuthenticatedAt) status.append(node("p",`Sist sett innlogget: ${displayMoment(sessionMaintenance.lastAuthenticatedAt)}`));
    status.append(node("p","Øktkontrollen erstatter ikke gjennomgang av barnas kilder."));
    holder.append(status);
  }
  if (completion) {
    const counts = completion.counts;
    const summary = completion.complete ? "Alle kontroller er fullført." : [
      `${counts.pendingItems} elementer venter på lesing`,
      `${counts.incompleteSurfaces} kildeområder er delvise`,
      `${counts.incompleteSources} kilder trenger ny kontroll eller har hull`,
      `${counts.missingDrive} filer mangler Drive-kopi`,
      `${counts.unsyncedCalendar} kalenderendringer venter`,
      `${counts.profileReviews ?? 0} kildeelementer venter på profilvurdering`
    ].join(" · ");
    const element = card(completion.complete ? "Gjennomgangen er fullført" : "Gjennomgangen er ikke fullført", summary);
    element.append(node("p", completion.complete ? "Siste kontroll fant ingen registrerte restanser." : "Åpne områder og synkroniseringsfeil må følges opp før neste kjøring kan regnes som ferdig."));
    if (completion.historyDays) element.append(node("p", `Aktivt kontrollvindu: siste ${completion.historyDays} dager og alle kommende avtaler. ${completion.historicalItems?.length ?? 0} eldre elementer og ${completion.historicalMissingDrive?.length ?? 0} historiske filer beholdes i arkivet uten å blokkere dagens gjennomgang.`));
    for (const gap of completion.historicalSurfaces ?? []) element.append(node("p", `Historisk hull utenfor kontrollvinduet: ${gap.source} · ${gap.surface} · ${gap.historicalGap.reason}`));
    holder.append(element);
  }
  if (coverage?.vigiloCoverage) {
    const matrix = node("div", undefined, "coverage-matrix");
    matrix.append(node("h3", "Vigilo per barn", "coverage-heading"));
    for (const entry of coverage.vigiloCoverage) {
      const cell = node("div", undefined, `coverage-cell ${entry.issues.length ? "incomplete" : "complete"}`);
      cell.append(node("strong", `${memberName(entry.child)} · ${entry.section === "news" ? "Siste nytt" : "Meldinger"}`), node("span", entry.issues.length ? `${entry.pending} åpne · ${entry.health}` : "Gjennomgått"));
      matrix.append(cell);
    }
    holder.append(matrix);
  }
  for (const source of ["vigilo", "spond", "facebook", "renovasjon"]) {
    const status = state.sourceStatus[source];
    const element = card(source === "renovasjon" ? "Min Renovasjon" : source === "facebook" ? "Facebook-grupper" : source === "vigilo" ? "Vigilo" : "Spond", status ? displayMoment(status.checkedAt) : "Ikke kontrollert");
    const tags = node("div", undefined, "tags");
    tags.append(tag(status?.health ?? "Ukjent", status?.health === "ok" ? "" : "error"));
    if (status?.seenCount !== null && status?.seenCount !== undefined) tags.append(tag(`${status.seenCount} elementer sett`));
    element.append(tags);
    if (status?.scope) element.append(node("p", `Dekning: ${status.scope}`));
    if (status?.details) element.append(node("p", status.details));
    holder.append(element);
  }
  for (const surface of Object.values(state.surfaces ?? {})) {
    const pending = coverage?.items?.filter((item) => item.source === surface.source && item.surface === surface.surface).length ?? 0;
    const element = card(`${surface.source} · ${surface.surface}`, surface.checkedAt ? displayMoment(surface.checkedAt) : "Ikke kontrollert");
    const tags = node("div", undefined, "tags");
    tags.append(tag(surface.health, surface.health === "ok" ? "" : "warn"));
    if (pending) tags.append(tag(`${pending} må gjennomgås`, "warn"));
    if (surface.seenCount !== null && surface.seenCount !== undefined) tags.append(tag(`${surface.seenCount} sett`));
    element.append(tags);
    if (surface.details) element.append(node("p", surface.details));
    if (surface.nextPageHint) element.append(node("p", `Neste steg: ${surface.nextPageHint}`));
    holder.append(element);
  }
  const runs = $("#run-list");
  runs.replaceChildren();
  if (!state.runs.length) runs.append(empty("Ingen gjennomgang er registrert ennå."));
  for (const run of state.runs.slice(0, 10)) {
    const element = card(run.outcome || "Kjøring", displayMoment(run.finishedAt));
    element.append(node("p", run.summary));
    runs.append(element);
  }
}
async function renderProfile() {
  if(profileEditor){profileEditor.update(state.profile);return;}
  if(profileLoading)return;profileLoading=true;
  try{const {installProfileEditor}=await import('./profile-editor.mjs?v='+Date.now());profileEditor=installProfileEditor(document.querySelector('#member-list'),{read:()=>profileRequest('/api/profile'),save:data=>profileRequest('/api/profile/edit',data),onSaved:()=>load()});profileEditor.update(state.profile);}
  catch{document.querySelector('#member-list').textContent='Profilredigeringen blir tilgjengelig når den pågående kjøringen er ferdig. Åpne Profil på nytt da.';}
  finally{profileLoading=false;}
}
function render() {
  if (!state) return;
  const pendingChoices=Object.values(state.events).filter(event=>event.visibility?.sync?.status==='pending');
  const syncStatus=$('#calendar-sync-status');syncStatus.hidden=!pendingChoices.length;
  syncStatus.textContent=pendingChoices.some(event=>event.visibility.sync.error) ? 'Noen Google-kalenderendringer venter på nytt forsøk. Se Skjulte oppføringer eller Kildedekning.' : `${pendingChoices.length} endring${pendingChoices.length===1?'':'er'} synkroniseres med Google-kalenderen …`;
  const scrolls = new Map(Array.from(document.querySelectorAll("[data-scroll-key]"),element=>[element.dataset.scrollKey,element.scrollTop]));
  document.body.dataset.view=tab;
  renderWeeklyLetter();
  loadHouseView();
  for (const button of document.querySelectorAll("#tabs button[data-tab]")) {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  if (kiosk) { const inMore = ["archive","sources","profile"].includes(tab); $("#more-button").classList.toggle("active", inMore); if (inMore) $("#more-button").setAttribute("aria-current","page"); else $("#more-button").removeAttribute("aria-current"); }
  for (const panel of document.querySelectorAll(".panel")) panel.classList.toggle("active", panel.id === (isCalendarTab(tab) ? "calendar" : tab));
  $(".filter-bar").hidden = tab === "sources" || tab === "profile" || tab === "house" || tab === "shopping" || tab === "explore";
  if (isCalendarTab(tab)) renderCalendar();
  if (tab === "archive") renderArchive();
  if (tab === "tasks") renderTasks();
  if (tab === "nearby") renderNearby();
  if (tab === "sources") renderSources();
  if (tab === "profile") renderProfile();
  if (tab === 'shopping') shoppingView.open();
  if (tab === 'explore') loadExplorer();
  for (const element of document.querySelectorAll("[data-scroll-key]")) element.scrollTop=scrolls.get(element.dataset.scrollKey) || 0;
}
async function loadExplorer() {
 (await explorerInstance()).open();
}
async function loadHouseView() {
 if(houseView||houseLoading)return;houseLoading=true;try{const {installHomeView}=await import("./home-view.mjs?v="+Date.now());houseView=installHomeView({panel:document.querySelector("#house"),rail:document.querySelector("#house-rail"),onOpen:()=>setTab("house"),onData:kiosk?kioskHome.setHome:undefined});}catch{document.querySelector("#house").textContent="Husvisningen aktiveres når den pågående kjøringen er ferdig.";}finally{houseLoading=false;}
}
function setTab(value) {
  if (value === "sources") load({ force:true }).catch(() => {});
  else if (value === "archive") { tab = value; load().catch(() => {}); }
  if (!isCalendarTab(tab) && isCalendarTab(value)) { anchorDay = osloDay(); selectedDay = anchorDay; }
  tab = value;
  render();
  $("main").scrollTop=0;
}
// Utlogget kilde: tydelig felt på alle faner, slik at ingen tror at nye ting hentes når innloggingen er borte.
function showLoginBanner() {
  const banner = $("#login-banner");
  // ?login=vigilo|spond|stale viser varselet med prøvedata (til testing av utseendet).
  const fake = new URLSearchParams(location.search).get("login");
  const session = fake === "vigilo" ? { health:"needs_login", checkedAt:new Date().toISOString(), stale:false } : sessionMaintenance;
  const surfaces = fake === "spond" ? { x:{ source:"spond", health:"needs_login" } } : state?.surfaces;
  const sourceStatus = fake === "stale" ? {} : state?.sourceStatus;
  const summary = state ? loginSummary(loginProblems({ sourceStatus, surfaces, session })) : null;
  banner.hidden = !summary;
  if (!summary) return;
  banner.className = `login-banner login-banner-${summary.level}`;
  banner.replaceChildren(node("strong", `${summary.level === "login" ? "🔒" : "⚠"}  ${summary.text}`), node("span", summary.hint ?? ""));
}
// Regn eller dårlig vær i skolevei/hjemvei vises som tydelig felt på alle faner.
function showWeatherBanner(data) {
  const banner = $("#weather-banner"), alert = data?.alert;
  banner.hidden = !alert;
  if (!alert) return;
  banner.textContent = `${alert.level === "snow" ? "❄" : "☂"}  ${alert.text}`;
  banner.className = `weather-banner weather-banner-${alert.level}`;
}
function returnHome() {
  if (kiosk) kioskHome.sleep();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  selectedMember="all"; anchorDay=osloDay(); selectedDay=anchorDay; showAllLater=false;
  $("#search").value=""; $("#source-filter").value="";
  setTab("overview"); renderPeople();
  for (const element of document.querySelectorAll("[data-scroll-key]")) element.scrollTop=0;
  window.scrollTo(0,0);
}
$("#dashboard-home").onclick=returnHome;
for (const button of document.querySelectorAll(".return-home")) button.onclick=returnHome;
if (kiosk) { installKiosk(()=>{if(!doorbellView.isOpen())returnHome();}); kioskHome.start({ onWeather: showWeatherBanner }); }
$("#more-button").onclick = () => $("#more-dialog").showModal();
$("#close-more").onclick = () => $("#more-dialog").close();
$("#more-dialog").onclick = event => { if (event.target === $("#more-dialog")) $("#more-dialog").close(); };
for (const button of document.querySelectorAll("[data-more-tab]")) button.onclick = () => { $("#more-dialog").close(); setTab(button.dataset.moreTab); };
for (const button of document.querySelectorAll("#tabs button[data-tab]")) button.onclick = () => setTab(button.dataset.tab);
for (const selector of ['#nearby-window','#nearby-filter']) $(selector).onchange=()=>render();
for (const button of document.querySelectorAll('[data-nearby-window]')) button.onclick=()=>{ $('#nearby-window').value=button.dataset.nearbyWindow; renderNearby(); };
for (const button of document.querySelectorAll('[data-nearby-filter]')) button.onclick=()=>{ $('#nearby-filter').value=button.dataset.nearbyFilter; renderNearby(); };
$("#previous-period").onclick = () => { anchorDay = tab === "week" ? addDays(anchorDay, -7) : kiosk ? addDays(anchorDay, -35) : shiftMonth(anchorDay, -1); selectedDay = anchorDay; renderCalendar(); };
$("#next-period").onclick = () => { anchorDay = tab === "week" ? addDays(anchorDay, 7) : kiosk ? addDays(anchorDay, 35) : shiftMonth(anchorDay, 1); selectedDay = anchorDay; renderCalendar(); };
$("#current-period").onclick = () => { anchorDay = osloDay(); selectedDay = anchorDay; renderCalendar(); };
$("#search").oninput = renderArchive;
$("#source-filter").onchange = renderArchive;
$("#close-dialog").onclick = () => $("#event-dialog").close();
$("#close-document").onclick = () => $("#document-dialog").close();
$("#document-dialog").onclose = releaseDocument;
$("#document-dialog").onclick = event => { if (event.target === $("#document-dialog")) $("#document-dialog").close(); };
$("#event-dialog").onclick = (event) => { if (event.target === $("#event-dialog")) $("#event-dialog").close(); };
let stateText = "";
const stateEtags = {};
let stateViewLoaded = null;
let heavyLoadedAt = 0;
// Dekningsdata (completion, review-queue) trengs bare i Dekning. Stueskjermen henter dem sjeldnere og tegner ikke på nytt uten endringer.
let serverPid = null;
// Stueskjermen laster seg selv på nytt når tjenesten er startet på nytt med ny kode.
async function checkServerRestart() {
  if (!kiosk) return;
  try {
    const response = await fetchTimed("/health");
    if (!response.ok) return;
    const health = await response.json();
    if (serverPid && health.pid !== serverPid) { location.reload(); return; }
    serverPid = health.pid;
  } catch { /* midlertidig utilgjengelig: prøv igjen neste runde */ }
}
const load = createRefresh(async ({ force = false } = {}) => {
  await checkServerRestart();
  // Stueskjermen henter en slank state, og full state bare i Arkiv og Dekning (der rådata og logger vises).
  const full = !kiosk || tab === "archive" || tab === "sources" || force;
  const heavy = !kiosk || tab === "sources" || force;
  const view = full ? "full" : "dashboard";
  const stateUrl = full ? "/api/state" : "/api/state?view=dashboard";
  const [stateResponse, coverageResponse, completionResponse, sessionResponse] = await Promise.all([fetchTimed(stateUrl, stateEtags[view] && state && stateViewLoaded === view ? { headers: { "If-None-Match": stateEtags[view] } } : undefined), heavy ? fetchOptional("/api/review-queue") : null, heavy ? fetchOptional("/api/completion") : null, fetchOptional("/api/session-maintenance")]);
  if (!stateResponse.ok && stateResponse.status !== 304) throw new Error(`HTTP ${stateResponse.status}`);
  const text = stateResponse.status === 304 ? stateText : await stateResponse.text();
  if (stateResponse.status !== 304) stateEtags[view] = stateResponse.headers.get("ETag");
  const viewChanged = stateViewLoaded !== view;
  stateViewLoaded = view;
  if (heavy) {
    coverage = coverageResponse?.ok ? await coverageResponse.json() : coverage;
    completion = completionResponse?.ok ? await completionResponse.json() : completion;
    heavyLoadedAt = Date.now();
  }
  sessionMaintenance = sessionResponse?.ok ? await sessionResponse.json() : sessionMaintenance;
  lastRefresh = new Date().toISOString();
  if (kiosk) kioskHome.setLastRefresh(lastRefresh);
  $("#connection-status").textContent = "";
  if (state && text === stateText && !viewChanged && !(heavy && tab === "sources")) { showLoginBanner(); return; }
  stateText = text;
  state = JSON.parse(text);
  showLoginBanner();
  renderPeople();
  render();
});
renderClock();
setInterval(() => {
  const currentDay = osloDay();
  renderClock();
  if (state && currentDay !== renderedDay && isCalendarTab(tab)) renderCalendar();
  renderedDay = currentDay;
}, 30_000);
const refresh = () => load().catch(() => { $("#connection-status").textContent = ` · Kontakt med PC-en mangler. Sist oppdatert ${displayMoment(lastRefresh)}. Prøver igjen automatisk.`; });
setInterval(refresh, kiosk ? 15_000 : 60_000);
window.addEventListener('online',refresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
load().catch((error) => $("#calendar-content").replaceChildren(empty(`Kunne ikke åpne arkivet: ${error.message}`)));
