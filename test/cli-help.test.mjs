import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
test('CLI help succeeds offline and advertises installed shopping interfaces to unattended agents',()=>{
 for(const args of [['--help'],['help'],[]]){const r=spawnSync(process.execPath,['src/cli.mjs',...args],{encoding:'utf8',windowsHide:true,env:{...process.env,FAMILIEN_API:'http://127.0.0.1:1'}});assert.equal(r.status,0,r.stderr);const h=JSON.parse(r.stdout);for(const command of ['shopping-agent-context','shopping-agent-guide','shopping-catalog','shopping-catalog-review','shopping-sesum-register','next','begin-run','run'])assert.ok(h.commands.includes(command),command);assert.ok(h.shoppingCommands.length>20);assert.match(h.shoppingStart,/commands are installed/);}
});
