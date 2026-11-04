import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const configPath=name=>resolve(process.env.FAMILIEN_CONFIG_DIR??fileURLToPath(new URL('../config/',import.meta.url)),name);
export const readConfig=name=>JSON.parse(readFileSync(configPath(name),'utf8'));
