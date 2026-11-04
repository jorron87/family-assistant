/* Read-only endpoints verified in the portals' own shipped clients (2026-09-29).
 * A resumable queue keeps files, polls and forms from starving the ordinary lists. */
(function(root){
  'use strict';
  const implementation = 'extra-auth-queue-2026-11-04';
  const safe = value => {
    if(Array.isArray(value))return value.map(safe);
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:token|password|authorization|secret)/i.test(key)).map(([key,v])=>[key,safe(v)]));
    return value;
  };
  const list = body => Array.isArray(body)?body:Array.isArray(body?.items)?body.items:Array.isArray(body?.consentForms)?body.consentForms:null;
  const unresolvedGroupFile = resource => {
    if(!resource?.id || resource.type==='LINK')return false;
    if(!resource.url)return true;
    try {
      const url=new URL(resource.url);
      return (url.hostname==='spond.com'||url.hostname==='api.spond.com') && url.pathname.startsWith('/storage/upload/group/');
    } catch { return true; }
  };
  async function run({source,state,config,now,fetchJson,server,sleep}) {
    if(source==='vigilo' && config?.vigiloConsents===false)state.queue=state.queue?.filter(task=>!['consents','consent-counts'].includes(task.section));
    // Recover tasks dropped by older clients without repeating healthy lists.
    for(const wanted of config?.want?.supplementalRetries ?? []) {
      if(source!=='vigilo'||wanted.source!==source||!['meetings','registrations'].includes(wanted.section)||typeof wanted.childId!=='string')continue;
      const key=wanted.section+':'+wanted.childId,stamp=Date.parse(wanted.requestedAt);
      state.retryRequests??={};
      if(!Number.isFinite(stamp)||stamp<=(state.retryRequests[key]??0))continue;
      state.queue??=[];
      if(!state.queue.some(task=>task.section===wanted.section&&task.childId===wanted.childId))state.queue.push({path:`/forms/${wanted.section}/invitations/${encodeURIComponent(wanted.childId)}`,section:wanted.section,childId:wanted.childId});
      state.retryRequests[key]=stamp;
    }
    if(state.retryAt>now() || !state.queue?.length && state.finishedAt && now()-state.finishedAt<3600000)return;
    const origin=source==='vigilo'?'https://web-parent.prod.vigilo-oas.no/api':'https://api.spond.com/core/v1';
    let used=0;
    async function get(path){await sleep(1500);used++;const r=await fetchJson(path.startsWith('https://')?path:origin+path);if(r.status<200||r.status>=300)throw Object.assign(Error('HTTP '+r.status),{status:r.status});return r.json;}
    if(!state.queue?.length) {
      try {
        if(source==='vigilo') {
          const children=list(await get('/children/my'));if(!children)throw Error('Uventet barneliste');
          state.queue=[{path:'/required-actions',section:'required-actions'}];
          for(const child of children) {
            for(const kind of ['meetings','registrations'])state.queue.push({path:`/forms/${kind}/invitations/${child.id}`,section:kind,childId:child.id});
            if(config?.vigiloConsents!==false){
              state.queue.push({path:`/consent-forms/counts?childPersonId=${child.id}`,section:'consent-counts',childId:child.id,signal:true});
              for(const unit of child.organizationalUnits ?? [])if(unit.id)state.queue.push({path:`/consent-forms?childId=${child.id}&organizationalUnitId=${unit.id}`,section:'consents',childId:child.id,unitId:unit.id});
            }
          }
        } else {
          const groups=list(await get('/groups'));if(!groups)throw Error('Uventet gruppeliste');
          state.groupIds=groups.map(g=>g.id).filter(Boolean);
          state.queue=['POLL','PAYMENT'].map(type=>({path:`/posts?type=${type}&includeComments=true&includeReadStatus=true&max=100`,section:type==='POLL'?'polls':'payments',paged:true}));
          for(const group of groups)if(group.id)state.queue.push({path:`/group/${group.id}/resources/folders/${group.id}`,section:'files',groupId:group.id,folderId:group.id});
        }
        state.seen=[];
      } catch(error){state.retryAt=now()+(error.code==='unauthorized'||[401,403].includes(error.status)?10:30)*60000;await server('/api/collector','POST',{source,kind:'supplemental-error',section:'discovery',detail:error.message,implementation});return;}
    }
    while(state.queue.length && used<14) {
      const task=state.queue[0];
      try {
        let body;
        if(task.resource) {
          const token=await get('/group/'+task.groupId+'/filesToken');
          if(typeof token.value!=='string')throw Error('Nedlastingstoken mangler');
          const download=await get('https://api.spond.com/storage/upload/group/'+encodeURIComponent(task.resource.id)+'?auth='+encodeURIComponent(token.value));
          if(!download.url)throw Error('Nedlastingslenke mangler');
          body={resources:[{...task.resource,url:download.url}]};
        } else body=await get(task.path);
        let items=task.signal?[body]:list(body);
        if(task.section==='files') {
          if(!body||typeof body!=='object'||!Array.isArray(body.resources)&&!Array.isArray(body.files)&&!Array.isArray(body.folders)&&body.itemCount!==0)throw Error('Uventet mappeformat');
          items=[...(body.resources ?? body.files ?? []),...(body.links ?? [])];
          // The folder listing may contain a portal URL that returns 401 without
          // the page's short-lived files token. Resolve it before sending it as
          // a downloadable original, and never persist the token in our queue.
          if(!task.resource)for(const resource of items)if(unresolvedGroupFile(resource))state.queue.push({...task,resource});
          for(const folder of body.folders ?? [])if(folder.id&&!state.seen.includes(folder.id)&&!state.queue.some(t=>t.folderId===folder.id))state.queue.push({...task,folderId:folder.id,path:`/group/${task.groupId}/resources/folders/${folder.id}`});
        }
        if(!items)throw Error('Uventet listeformat');
        const complete=!task.paged||items.length<100;
        const reported=task.section==='files'&&!task.resource
          ?items.map(resource=>unresolvedGroupFile(resource)?{...resource,url:null}:resource)
          :items;
        const pageItems = safe(reported);
        const accumulated = task.paged ? [...(task.accumulated ?? []), ...pageItems] : pageItems;
        await server('/api/collector','POST',{source,kind:'supplemental',section:task.section,childId:task.childId,unitId:task.unitId,groupId:task.groupId,folderId:task.folderId,groupIds:state.groupIds,url:origin+task.path,complete,signal:task.signal===true,items:accumulated,implementation});
        if(task.paged&&items.length===100) {
          const last=items.at(-1),next=new URL(origin+task.path);
          if(!last.id||!last.timestamp||state.seen.includes(last.id))throw Error('Paginering ga ikke fremdrift');
          next.searchParams.set('prevId',last.id);next.searchParams.set('maxTimestamp',last.timestamp);
          state.queue.push({...task,accumulated,path:next.pathname.replace('/core/v1','')+next.search});state.seen.push(last.id);
        }
        if(task.folderId)state.seen.push(task.folderId);
      } catch(error) {
        await server('/api/collector','POST',{source,kind:'supplemental-error',section:task.section,childId:task.childId,unitId:task.unitId,groupId:task.groupId,folderId:task.folderId,detail:error.message,implementation});
        // fetchJson can throw before HTTP when the app has no fresh credential.
        // Keep this task at the queue head, just as for an actual HTTP 401.
        // Dropping it marked the round finished and postponed it for an hour.
        if(error.code==='unauthorized'||[401,403].includes(error.status)){state.retryAt=now()+10*60000;return;}
        if(error.status===429||error.status>=500){state.retryAt=now()+30*60000;return;}
      }
      state.queue.shift();
    }
    if(!state.queue.length){state.finishedAt=now();state.retryAt=0;}
  }
  root.FamilienCollectorExtra={run,safe};
})(globalThis);
