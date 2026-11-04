import {cleanText,short} from './activity-feeds.mjs';

// The public Axiell widget's own config and paginated read API, not the empty HTML shell.
export async function crawlLibrary({from,to,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const page='https://www.drammensbiblioteket.no/events';
  const response=await fetchImpl(page,{signal:AbortSignal.timeout(25000)});if(!response.ok)throw Error(`Bibliotekside HTTP ${response.status}`);
  const html=await response.text(),groupId=html.match(/getScopeGroupId:function\(\)\{return"(\d+)"/)?.[1];
  if(!groupId)throw Error('Bibliotekets offentlige widgetkonfigurasjon er endret.');
  const csrf=html.match(/authToken\s*[:=]\s*["']([^"']+)/)?.[1];
  const cookie=(response.headers.getSetCookie?.()??[]).map(x=>x.split(';')[0]).join('; ');
  const configReply=await fetchImpl('https://www.drammensbiblioteket.no/api/jsonws/invoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest',Referer:page,Cookie:cookie},body:new URLSearchParams({cmd:JSON.stringify({'/arenacalendar.calendar/get-calendar-config':{groupId}}),...(csrf?{p_auth:csrf}:{})}),signal:AbortSignal.timeout(25000)});
  if(!configReply.ok)throw Error(`Bibliotekkonfigurasjon HTTP ${configReply.status}`);
  const config=await configReply.json();
  if(config.calendarApiEndpoint!=='https://api.axiell.com/event/api'||!config.customerId)throw Error('Bibliotekets kalenderadresse er endret.');
  const events=new Map();let total=null;
  for(let start=0;start<5000;start+=100){
    const url=new URL(`${config.calendarApiEndpoint}/customers/${encodeURIComponent(config.customerId)}/search`);
    url.search=new URLSearchParams({queryString:'event.title:* OR event.description:* OR event.location.value:*',rangeFilters:JSON.stringify([{field:'event.endDate',gte:from+'T00:00:00.000Z'},{field:'event.startDate',lte:to+'T23:59:59.999Z'}]),termFilters:JSON.stringify([{field:'event.status',values:['PUBLISHED','CANCELLED']},{type:'NOT_IN',field:'event.deleted',values:[true]}]),sorts:JSON.stringify([{field:'event.startDate',order:'ASC'}]),start:String(start),size:'100'});
    const reply=await fetchImpl(url,{signal:AbortSignal.timeout(25000)});if(!reply.ok)throw Error(`Bibliotekkalender HTTP ${reply.status}`);
    const data=await reply.json();if(!Array.isArray(data.hits)||!Number.isInteger(data.totalHits))throw Error('Uventet format fra bibliotekkalenderen.');
    total=data.totalHits;let fresh=0;
    for(const hit of data.hits){const e=hit.event;if(!e?.id||!e.title||!e.startDate)throw Error('Ufullstendig arrangement i bibliotekkalenderen.');if(!events.has(e.id))fresh++;
      events.set(e.id,{id:e.id,title:e.title,start:e.startDate,end:e.endDate,status:e.status,description:cleanText(e.description??'').join('\n'),location:e.location?.value,room:e.room?.value,targetAudiences:e.targetAudiences,registerable:e.registerable,registration:e.registration,externalUrl:e.externalUrl,price:e.price,url:`${page}#/events/${e.id}`});
    }
    if(events.size>=total){const lines=[...events.values()].flatMap(e=>[`${e.id}: ${e.title}`,`${e.start} — ${e.end} | ${e.status}`,JSON.stringify({location:e.location,room:e.room,targetAudiences:e.targetAudiences,registerable:e.registerable,registration:e.registration,externalUrl:e.externalUrl,price:e.price}),e.url,...e.description.split('\n')]);return {lines,lineHashes:lines.map(line=>short(line).slice(0,8)),hash:short(lines.join('\n')),chars:lines.join('\n').length,total,complete:true};}
    if(!fresh)throw Error('Bibliotekkalenderens paginering stanset før alle arrangementer var hentet.');await sleep(1000);
  }
  throw Error('Bibliotekkalenderen overskred 5000 arrangementer; dekningen er ikke fullført.');
}
