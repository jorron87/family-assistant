import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedReleasePath,inspectReleaseText} from '../src/release-privacy.mjs';
test('private instance files are forbidden even if forcibly added to Git',()=>{
 for(const p of ['config/sources.json','.local/AGENTS.md','.local/privacy.json','docs/drift/today.md','phone-intake.json','test/private.pdf','artifacts/screenshot.png'])assert.equal(allowedReleasePath(p),false,p);
 for(const p of ['config/sources.example.json','config/vigilo-keepalive/manifest.json','src/store.mjs','test/config/profile.json','.githooks/pre-push','docs/git-workflow.md','docs/images/system-map.svg'])assert.equal(allowedReleasePath(p),true,p);
 assert.equal(allowedReleasePath('docs/images/family-photo.png'),false);
});
test('local privacy policy checks content without exposing matches in errors',()=>{
 assert.deepEqual(inspectReleaseText('normal code'),[]);
 assert.deepEqual(inspectReleaseText('private-member-needle',{privateTerms:['private-member-needle']}),['local private identifier']);
 assert.deepEqual(inspectReleaseText('Native-ID: 12345',{privatePatterns:['Native-ID: \\d+']}),['local private pattern']);
 assert.ok(inspectReleaseText('reader@school.invalid').length===0);
 assert.ok(inspectReleaseText('reader@'+'real-school.edu').includes('non-example email'));
});
