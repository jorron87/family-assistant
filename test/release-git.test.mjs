import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
test('staged blobs and removed history remain checked independently of clean working files',()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-git-guard-'));
 const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const guard=(args,input)=>spawnSync(process.execPath,['scripts/privacy-check.mjs',...args],{cwd:dir,input,encoding:'utf8'});
 const put=(p,s)=>writeFileSync(join(dir,p),s);
 try{
  for(const d of ['scripts','src','.local'])mkdirSync(join(dir,d));
  for(const p of ['scripts/privacy-check.mjs','src/release-privacy.mjs'])copyFileSync(resolve(p),join(dir,p));
  git('init','--initial-branch=main');git('config','user.name','Synthetic contributor');git('config','user.email','contributor@example.org');git('config','core.hooksPath','.no-hooks');
  put('.gitignore','/.local/\n');put('.local/privacy.json',JSON.stringify({privateTerms:['synthetic-private-marker']}));
  put('src/demo.mjs','synthetic-private-marker');git('add','.');
  put('src/demo.mjs','export const safe=true;');
  const staged=guard(['--staged']);assert.equal(staged.status,1);assert.ok(!staged.stderr.includes('synthetic-private-marker'),'matched private values stay out of errors');
  git('commit','-m','Synthetic regression fixture');
  git('add','src/demo.mjs');git('commit','-m','Remove synthetic private fixture');
  assert.equal(guard(['--head']).status,0);
  assert.equal(guard(['--push'],`refs/heads/main ${git('rev-parse','HEAD')} refs/heads/main ${'0'.repeat(40)}\n`).status,1,'deleted content remains in outgoing history');
  mkdirSync(join(dir,'config'));put('config/sources.json','{}');git('add','config/sources.json');
  assert.equal(guard(['--staged']).status,1,'private configuration is rejected even without identifying values');
 }finally{assert.equal(resolve(dir).startsWith(resolve(tmpdir(),'family-git-guard-')),true);rmSync(dir,{recursive:true,force:true});}
});
