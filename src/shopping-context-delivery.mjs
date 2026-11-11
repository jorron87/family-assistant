import {createHash} from 'node:crypto';
import {agentContextPages,agentContextView} from './shopping-agent-context.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const workerContextPages=frame=>agentContextPages(frame.packet,8000,{separateSourceRows:frame.sourceRowsSeparate===true});

// Page delivery is evidence of reading only those bytes. A complete source row
// can also survive repacking, but an incomplete split row cannot lend such a
// receipt. Metadata, source indexes and text-reference indexes are all hashed.
function deliveredSources(previous,pages){
 const delivered=new Set(),served=new Set(previous.served),rows=agentContextView(previous.packet).sources;
 const chunks=new Map();
 for(const [index,page]of pages.sources.entries()){
  if(page.items){if(served.has('sources:'+index))for(const row of page.items)delivered.add(digest(row));}
  else{const indices=chunks.get(page.rowIndex)??[];indices.push(index);chunks.set(page.rowIndex,indices);}
 }
 for(const [rowIndex,indices]of chunks)if(indices.every(i=>served.has('sources:'+i)))delivered.add(digest(rows[rowIndex]));
 return delivered;
}

export function planWorkerContextDelivery(packet,{previous=null,provided=false,familyProvided=false}={}){
 const packed=agentContextPages(packet),old=previous?workerContextPages(previous):null;
 const previousServed=new Set(previous?.served??[]),known=new Map();
 for(const [section,pages]of Object.entries(old??{}))known.set(section,new Set(pages.filter((_,i)=>previousServed.has(section+':'+i)).map(digest)));
 const rowReceipts=previous?deliveredSources(previous,old):new Set(),sources=agentContextView(packet).sources;
 const sourceKnown=page=>provided||known.get('sources')?.has(digest(page))||(page.items?page.items.every(row=>rowReceipts.has(digest(row))):rowReceipts.has(digest(sources[page.rowIndex])));
 // Choose from two bounded encodings of exactly the same current rows. Cold
 // reads/all-source changes stay compact; isolated updates can reuse neighbours.
 const aligned=agentContextPages(packet,8000,{separateSourceRows:true}).sources;
 const choices=[{separate:false,pages:packed.sources},{separate:true,pages:aligned}].map(c=>{const unread=c.pages.filter(p=>!sourceKnown(p));return {...c,missing:unread.length,characters:unread.reduce((n,p)=>n+JSON.stringify(p).length,0)};});
 choices.sort((a,b)=>a.missing-b.missing||a.characters-b.characters||a.pages.length-b.pages.length);
 const chosen=choices[0],pages={...packed,sources:chosen.pages},served=[];
 for(const [section,rows]of Object.entries(pages))for(const [i,page]of rows.entries())if(provided||section==='families'&&familyProvided||section==='sources'&&sourceKnown(page)||known.get(section)?.has(digest(page)))served.push(section+':'+i);
 return {sourceRowsSeparate:chosen.separate,pages,served};
}
