import {spawn} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const files=readdirSync('test').filter(n=>n.endsWith('.test.mjs')).map(n=>'test/'+n);
const child=spawn(process.execPath,['--test',...process.argv.slice(2),...files],{stdio:'inherit',env:{...process.env,FAMILIEN_CONFIG_DIR:resolve('test/config')}});
child.on('exit',code=>process.exit(code??1));
