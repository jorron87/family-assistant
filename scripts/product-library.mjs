import {readProductLibrary} from '../src/product-library.mjs';
import {writeShoppingIndex} from '../src/shopping-library.mjs';

const usage='Usage: node scripts/product-library.mjs FILE summary | search QUERY | compare GROUP_ID | audit | shopping-index OUTPUT [--now ISO_TIMESTAMP] [--limit N] [--pretty]';
function main(args) {
 if(args.length===1&&args[0]==='--help'){console.log(usage);return;}
 const positional=[],options={};
 for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--pretty'){options.pretty=true;continue;}
  if(arg==='--now'||arg==='--limit'){
   if(options[arg.slice(2)]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error(usage);
   options[arg.slice(2)]=args[++i];continue;
  }
  if(arg.startsWith('--'))throw Error(usage);
  positional.push(arg);
 }
 const [file,command,...values]=positional;
 if(command==='shopping-index'){if(values.length!==1)throw Error(usage);console.log(JSON.stringify(writeShoppingIndex(file,values[0])));return;}
 if(!file||!['summary','search','compare','audit'].includes(command)||!['search','compare'].includes(command)&&values.length||command==='compare'&&values.length!==1||command==='search'&&!values.length)throw Error(usage);
 if(options.now!==undefined&&(!/^\d{4}-\d{2}-\d{2}T/.test(options.now)||!/(?:Z|[+-]\d{2}:\d{2})$/.test(options.now)||!Number.isFinite(Date.parse(options.now))))throw Error('--now must be an ISO timestamp with timezone.');
 if(options.limit!==undefined&&(!/^[1-9]\d*$/.test(options.limit)||!['search','audit'].includes(command)))throw Error('--limit requires a positive integer for search or audit.');
 const library=readProductLibrary(file,options.now?{now:options.now}:{}),limit=options.limit===undefined?undefined:Number(options.limit);
 const result=command==='summary'?library.summary():command==='search'?library.search(values.join(' '),limit===undefined?{}:{limit}):command==='compare'?library.compare(values[0]):library.audit(limit===undefined?{}:{limit});
 console.log(JSON.stringify(result,null,options.pretty?2:undefined));
 if(command==='audit'&&!result.ok)process.exitCode=2;
}
try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}
