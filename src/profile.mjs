import {readFileSync,existsSync} from 'node:fs';
import {configPath} from './config.mjs';
const local=process.env.FAMILIEN_PROFILE_CONFIG??configPath('profile.json');
export const initialProfile=JSON.parse(readFileSync(existsSync(local)?local:new URL('../config/profile.example.json',import.meta.url),'utf8'));
if(!Array.isArray(initialProfile.members)||!initialProfile.members.length)throw Error('Configure at least one family member.');
if(new Set(initialProfile.members.map(m=>m.id)).size!==initialProfile.members.length||initialProfile.members.some(m=>!m.id||!m.name||!['parent','child'].includes(m.role)))throw Error('Each member needs a unique stable ID, name and parent/child role.');
