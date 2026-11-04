// Normalize only native object IDs, never names, dates, group IDs or inferred keys.
export function sourceIdentity(source,value) {
 const text=String(value??'').trim();
 const uuid='([a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12})';
 const kinds=source==='vigilo'?'news|message|messages':source==='spond'?'post|event|poll|file':null;
 if(!kinds)return text;
 const match=text.match(new RegExp(`^(?:${source}:)?(${kinds}):${uuid}$`,'i'));
 if(!match)return text;
 return `${source}:${match[1].toLowerCase().replace(/^messages$/,'message')}:${match[2].replaceAll('-','').toLowerCase()}`;
}
