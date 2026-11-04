import test from 'node:test';
import assert from 'node:assert/strict';
import {memberColor} from '../public/member-colors.mjs';
test('member colors follow child/parent order and explicit choices independent of private names and IDs',()=>{
 const members=[{id:'adult-x',role:'parent'},{id:'adult-y',role:'parent'},{id:'kid-x',role:'child'},{id:'kid-y',role:'child',color:'#123456'}];
 assert.equal(memberColor(members,'adult-x'),'#808789');assert.equal(memberColor(members,'adult-y'),'#987b9a');
 assert.equal(memberColor(members,'kid-x'),'#c57b84');assert.equal(memberColor(members,'kid-y'),'#123456');
});
