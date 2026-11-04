import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
test('service diagnostics records an actual crash without swallowing failure',()=>{
  const directory=mkdtempSync(join(tmpdir(),'familien-web-log-'));
  try {
    const result=spawnSync(process.execPath,['--require',resolve('scripts/web-diagnostics.cjs'),'-e','throw Error("diagnostics test")'],{env:{...process.env,LOCALAPPDATA:directory},encoding:'utf8'});
    assert.equal(result.status,1);
    const entries=readFileSync(join(directory,'Familien','logs','web-process.log'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(entries.map(entry=>entry.kind),['start','crash','exit']);
    assert.match(entries[1].error,/diagnostics test/);
    assert.equal(entries[2].code,1);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
