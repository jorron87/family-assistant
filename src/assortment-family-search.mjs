import {createHash} from 'node:crypto';
const tokens=value=>String(value??'').normalize('NFC').toLocaleLowerCase('nb-NO').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(' ').filter(Boolean);
/** Search actual global family definitions, never the query's household hints.
 * Ranking only retrieves candidates; it cannot approve a product membership. */
export function searchAssortmentFamilies(index,query,{offset=0,limit=20,expectedFingerprint=null}={}){
 if(typeof query!=='string'||query.trim().length<2||query.length>200||!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Use a family query, nonnegative offset and 1–100 results.');
 const terms=[...new Set(tokens(query))],matches=[];
 for(const [groupId,g] of Object.entries(index?.groups??{})){
  const name=tokens(g.name),category=tokens(g.category),criteria=tokens([g.inclusion,g.comparisonBasis,g.qualityBasis].flat().join(' ')),hasTerm=(words,term)=>words.some(word=>word.startsWith(term));
  const score=terms.reduce((n,t)=>n+(hasTerm(name,t)?8:0)+(hasTerm(category,t)?2:0)+(t!=='and'&&hasTerm(criteria,t)?1:0),0);
  if(score)matches.push({groupId,...g,score});
 }
 matches.sort((a,b)=>b.score-a.score||a.groupId.localeCompare(b.groupId));
 const fingerprint=createHash('sha256').update(JSON.stringify([terms,matches])).digest('hex');
 if(expectedFingerprint!=null&&expectedFingerprint!==fingerprint)throw Error('Family search changed; restart at offset 0.');
 const items=matches.slice(offset,offset+limit),hasMore=offset+items.length<matches.length;
 return {query,items,total:matches.length,offset,limit,nextOffset:hasMore?offset+items.length:null,hasMore,fingerprint,authority:'Candidate retrieval from current complete family definitions. Search rank is not equivalence evidence. Source search hints are not used.'};
}
