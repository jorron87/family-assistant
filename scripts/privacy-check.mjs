import {readdirSync,readFileSync,existsSync} from 'node:fs';
import {join,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd(),skip=new Set(['.git','node_modules','tmp','.runtime','.family-data','coverage','artifacts']);
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>skip.has(e.name)?[]:e.isDirectory()?walk(join(dir,e.name)):[relative(root,join(dir,e.name)).replaceAll('\\','/')]);}
let files;
try{files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);}catch{files=[];}
if(!files.length)files=walk(root).filter(p=>!/^config\/[^/]+\.json$/.test(p)||p.endsWith('.example.json'));
const problems=[];
for(const p of files){
 if(/^config\/[^/]+\.json$/.test(p)&&!p.endsWith('.example.json'))problems.push(p+': local deployment config');
 if(/(?:^|\/)(?:\.env(?:\..*)?|key\.dpapi)$/.test(p)||/\.(?:enc|dpapi|pem|pfx|p12|pdf|docx?|png|jpe?g)$/i.test(p))problems.push(p+': private/binary artifact requires explicit release review');
 if(!existsSync(p))continue;
 const s=readFileSync(p,'utf8');
 const secret=/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AIza[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
 if(secret.test(s))problems.push(p+': possible credential');
 if(/C:[\\/]+Users[\\/]+[^\\/"'\s]+|\/home\/(?!dashboard\b|user\b)[a-z][a-z0-9_-]+/i.test(s))problems.push(p+': personal home path');
 const emails=s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)??[];
 if(emails.some(e=>!/@(?:[\w.-]*example\.(?:com|org|net)|[\w.-]+\.(?:test|invalid|local))$/i.test(e)))problems.push(p+': non-example email address');
}
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}else console.log('Privacy guard passed for '+files.length+' release files. Review the diff too; this is not a proof of anonymity.');
