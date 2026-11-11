// Only fixed operation categories and numbers leave this reducer. In particular,
// never retain a tool's arguments, results, URLs, labels, errors or capability.
const reads=new Set(['library-search','product','group','source-candidates','source-offers','profile','research','page']);
const sections=new Set(['jobs','families','sources','products','texts']);
const operations=new Set(['placement','source-register','source-review','source-offer-review','family-add-variant','catalog-review']);
const itemKinds=new Map(Object.entries({web_search:'web',web_search_call:'web',command_execution:'command',code_execution:'code',file_change:'file',todo_list:'plan',image_view:'image'}));
function category(item){
 if(item.type==='mcp_tool_call'){
  const input=item.arguments&&typeof item.arguments==='object'?item.arguments:{};
  if(item.tool==='shopping_read')return 'read:'+(reads.has(input.kind)?input.kind:'other');
  if(item.tool==='shopping_context')return input.section?'context:page:'+(sections.has(input.section)?input.section:'other'):input.refresh?'context:refresh':'context:header';
  if(item.tool==='shopping_propose')return 'propose:'+(operations.has(input.operation)?input.operation:'other');
  if(item.tool==='shopping_checkpoint')return 'checkpoint';
  return 'mcp:other';
 }
 return itemKinds.get(item.type)??'other';
}
export function createWorkerToolMetrics({now=()=>performance.now()}={}){
 const active=new Map(),completed=new Set(),kinds={},begin=now();let last=begin,toolWallMs=0,firstToolAfterMs=null,droppedStarts=0;
 const advance=()=>{const at=Math.max(last,now());if(active.size)toolWallMs+=at-last;last=at;return at;};
 const row=kind=>kinds[kind]??=( {calls:0,errors:0,timedCalls:0,totalMs:0,maxMs:0} );
 function consume(event){
  const item=event?.item;if(!item||item.type==='agent_message'||item.type==='reasoning'||!['item.started','item.completed'].includes(event.type))return;
  const at=advance(),kind=category(item),id=typeof item.id==='string'&&item.id.length<=200?item.id:null;
  if(firstToolAfterMs===null)firstToolAfterMs=at-begin;
  if(event.type==='item.started'){
   if(id&&!completed.has(id)&&!active.has(id)){if(active.size<2048)active.set(id,{at,kind});else droppedStarts++;}
   return;
  }
  if(id&&completed.has(id))return;
  const started=id?active.get(id):null,stats=row(started?.kind??kind);stats.calls++;
  if(item.error!=null||item.status==='failed'||item.result?.isError===true)stats.errors++;
  if(started){const ms=at-started.at;stats.timedCalls++;stats.totalMs+=ms;stats.maxMs=Math.max(stats.maxMs,ms);active.delete(id);}
  if(id){completed.add(id);if(completed.size>4096)completed.delete(completed.values().next().value);}
 }
 function snapshot(){advance();return {version:1,firstToolAfterMs:firstToolAfterMs===null?null:Math.round(firstToolAfterMs),toolWallMs:Math.round(toolWallMs),pendingTimedCalls:active.size,droppedStarts,kinds:Object.fromEntries(Object.entries(kinds).map(([kind,stats])=>[kind,{...stats,totalMs:Math.round(stats.totalMs),maxMs:Math.round(stats.maxMs)}]))};}
 return {consume,snapshot};
}
