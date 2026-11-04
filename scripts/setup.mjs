import {readdirSync,existsSync,copyFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const dir=new URL('../config/',import.meta.url);
for(const name of readdirSync(dir).filter(n=>n.endsWith('.example.json'))){const to=new URL(name.replace('.example.json','.json'),dir);if(!existsSync(to)){copyFileSync(new URL(name,dir),to);console.log('Created '+fileURLToPath(to));}}
console.log('Edit config/profile.json and config/sources.json, then npm run doctor. Collection and agents stay disabled until explicitly enabled.');
