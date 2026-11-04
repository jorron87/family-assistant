// Reads a newly authorized dedicated integration key from stdin, never logs it.
import {readFileSync} from 'node:fs';
import {createHomeAssistant} from '../src/home-assistant.mjs';
import {DATA_DIR} from '../src/store.mjs';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const token=Buffer.concat(chunks).toString('utf8').trim();
try {
 const config=JSON.parse(readFileSync(new URL('../config/home-assistant.json',import.meta.url)));
 const home=createHomeAssistant({config,dataDir:DATA_DIR});
 const result=await home.connect(token);
 process.stdout.write(JSON.stringify({connected:result.status==='ok',entityCount:result.entities.length,available:result.entities.filter(e=>e.available).length}));
} catch(error){process.stderr.write(error.message);process.exitCode=1;}
