import {execFileSync} from 'node:child_process';
execFileSync('git',['config','--local','core.hooksPath','.githooks']);
console.log('Installed local pre-commit, commit-message and pre-push privacy checks.');
