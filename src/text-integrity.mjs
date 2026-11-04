// Source files remain evidence. This checks generated display text, never URLs
// or identities, and deliberately does not guess which missing letter was meant.
export function assertDisplayText(input) {
  const fields = new Set(['title','body','details','reason','timeNote','pitch','summary','text','practical','registration','audience','location']);
  function visit(value, path='') {
    if (!value || typeof value !== 'object') return;
    for (const [key, text] of Object.entries(value)) {
      if (fields.has(key) && typeof text === 'string') {
        const prose=text.replace(/https?:\/\/\S+/g,'');
        // Fixed-width neighbours keep this linear for megabyte-sized extracts
        // containing a single uninterrupted word (including machine output).
        const brokenWords=prose.match(/(?<=\p{L})\?(?=\p{L})/gu)??[];
        if (/\uFFFD|Ã[\u0080-\u00BF]|â[€\u0080-\u009F]/u.test(prose) || brokenWords.length>=2 || /\b(?:[Gg]j\?r|[Ll]\?r|[Ss]v\?mming|[Kk]ropps\?ving)\b/.test(prose)) {
          throw Error(`Mulig tegnskade i ${path+key}. Les originalen og skriv JSON som UTF-8-fil. Windows PowerShell-piping kan erstatte bokstaver med ?. Ingen tekst er automatisk rettet.`);
        }
      } else if (key==='checklist' && Array.isArray(text)) visit(text.map(text=>({text})),path+'checklist.');
      else if (['findings','task','items'].includes(key) || Array.isArray(value)) visit(text,path+key+'.');
    }
  }
  visit(input);
}

// Exact inverse of UTF-8 bytes accidentally decoded as Windows-1252. Only
// valid multi-byte sequences are replaced; genuine Unicode stays untouched.
const c1='€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
const byteFor=new Map(Array.from({length:256},(_,i)=>[i>=128&&i<160?[...c1][i-128]:String.fromCharCode(i),i]));
// Also accept a literal Latin-1 misdecode of the C1 range.
for(let i=128;i<160;i++)byteFor.set(String.fromCharCode(i),i);
const utf8=new TextDecoder('utf-8',{fatal:true});
export function undoMojibake(text) {
  const chars=[...text];let out='';
  for(let i=0;i<chars.length;i++) {
    const first=byteFor.get(chars[i]);
    const size=first>=0xc2&&first<=0xdf?2:first>=0xe0&&first<=0xef?3:first>=0xf0&&first<=0xf4?4:0;
    const bytes=chars.slice(i,i+size).map(c=>byteFor.get(c));
    if(size && bytes.length===size && bytes.slice(1).every(b=>b>=0x80&&b<=0xbf)) {
      try {out+=utf8.decode(Uint8Array.from(bytes));i+=size-1;continue;}catch{}
    }
    out+=chars[i];
  }
  return out;
}

export function validateTextRestoration(before,after) {
  if(typeof before!=='string'||typeof after!=='string'||before===after)throw Error('Tekstretting trenger ulik før/etter-tekst.');
  const normalized=undoMojibake(before),a=[...normalized],b=[...after];
  if(a.length!==b.length || a.some((c,i)=>c!==b[i] && !(['?','\uFFFD'].includes(c)&&b[i].codePointAt(0)>127)))throw Error('Bare restaurering av ødelagte tegn er tillatt; innhold og identiteter skal bevares.');
}

export function prepareTextRepairs(state,changes) {
  if(!Array.isArray(changes)||!changes.length||changes.length>1000)throw Error('Oppgi en avgrenset liste med tekstrettinger.');
  const copies=new Map(),seen=new Set();
  const allowed={events:/^(?:title|details|reason|timeNote|checklist\.\d+|task\.(?:items|history)\.\d+\.text)$/,rawItems:/^(?:title|body|profileReviewNote)$/,activities:/^(?:title|pitch|summary|reason|evidence|organizer|price|registration|practical|location|audience)$/};
  for(const change of changes) {
    const {collection,id,path,before,after}=change;
    if(!allowed[collection]?.test(path)||!Object.hasOwn(state[collection]??{},id))throw Error('Ukjent tekstfelt eller oppføring.');
    const identity=collection+':'+id,key=identity+':'+path;
    if(seen.has(key))throw Error('Samme felt er oppgitt flere ganger.');seen.add(key);
    if(!copies.has(identity))copies.set(identity,{collection,id,record:structuredClone(state[collection][id])});
    let target=copies.get(identity).record;const parts=path.split('.'),last=parts.pop();
    for(const part of parts){if(!target||!Object.hasOwn(target,part))throw Error('Tekstfeltet finnes ikke.');target=target[part];}
    if(!target||!Object.hasOwn(target,last)||target[last]!==before)throw Error('Teksten er endret siden kontrollen; les den på nytt.');
    validateTextRestoration(before,after);target[last]=after;
  }
  return [...copies.values()];
}
