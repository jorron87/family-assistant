import {readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {allowedReleasePath,inspectReleaseText,approvedImage} from '../src/release-privacy.mjs';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:32*1024*1024});
const policy=existsSync('.local/privacy.json')?JSON.parse(readFileSync('.local/privacy.json','utf8')):{};
const problems=[],seen=new Set();
const blobs=new Map();
let checked=0;
const inspect=(path,content)=>{checked++;
 if(path===approvedImage.path){if(createHash('sha256').update(content).digest('hex')!==approvedImage.sha256)problems.push(path+': image differs from visually reviewed synthetic illustration');return;}
 for(const reason of inspectReleaseText(content.toString('utf8'),policy))problems.push(path+': '+reason);};
function entries(output){return output.split('\0').filter(Boolean).map(row=>{const tab=row.indexOf('\t');const meta=row.slice(0,tab).split(' ');return {path:row.slice(tab+1),sha:meta[meta.length-2]??meta[1],meta};});}
function loadBlobs(shas){
 const needed=[...new Set(shas)].filter(sha=>!blobs.has(sha));if(!needed.length)return;
 const output=execFileSync('git',['cat-file','--batch'],{input:needed.join('\n')+'\n',maxBuffer:32*1024*1024});
 let offset=0;
 for(const sha of needed){const end=output.indexOf(10,offset);const [actual,type,size]=output.subarray(offset,end).toString().split(' ');if(actual!==sha||type!=='blob'||!/^\d+$/.test(size))throw Error('Cannot verify a Git blob');offset=end+1;blobs.set(sha,output.subarray(offset,offset+Number(size)));offset+=Number(size)+1;}
}
function scan(rows,tree=false){
 if(!process.argv.includes('--worktree'))loadBlobs(rows.filter(row=>allowedReleasePath(row.path)).map(row=>tree?row.meta[2]:row.meta[1]));
 for(const row of rows){
 const sha=tree?row.meta[2]:row.meta[1];
 if(!allowedReleasePath(row.path)){problems.push(row.path+': disallowed release path');continue;}
 for(const reason of inspectReleaseText(row.path,policy))problems.push(row.path+': '+reason);
 const key=row.path+':'+sha;if(seen.has(key))continue;seen.add(key);
 if(process.argv.includes('--worktree')){if(existsSync(row.path))inspect(row.path,readFileSync(row.path));}
 else inspect(row.path,blobs.get(sha));
}}
if(process.argv.includes('--message'))inspect('commit message',readFileSync(process.argv[process.argv.indexOf('--message')+1],'utf8'));
else if(process.argv.includes('--push')){
 const commits=new Set();
 for(const line of readFileSync(0,'utf8').trim().split('\n').filter(Boolean)){
  const [,local,,remote]=line.trim().split(/\s+/);if(/^0+$/.test(local))continue;
  if(!/^[a-f0-9]{40,64}$/.test(local)||!/^[a-f0-9]{40,64}$/.test(remote))throw Error('Invalid push revision');
  commits.add(local);
  for(const sha of git('rev-list',local,...(/^0+$/.test(remote)?['--not','--remotes=origin']:['^'+remote])).trim().split('\n').filter(Boolean))commits.add(sha);
 }
 for(const sha of commits){inspect('commit message',git('show','-s','--format=%B',sha));scan(entries(git('ls-tree','-rz',sha)),true);}
}else if(process.argv.includes('--head'))scan(entries(git('ls-tree','-rz','HEAD')),true);
else scan(entries(git('ls-files','-s','-z')));
if(problems.length){console.error([...new Set(problems)].join('\n'));process.exitCode=1;}else console.log('Privacy guard passed ('+checked+' blobs/messages). Local policy values are never printed. Review the diff too.');
