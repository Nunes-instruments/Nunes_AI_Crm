import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR=path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT=path.resolve(SERVICE_DIR,'..');
const candidates=[path.join(SERVER_ROOT,'.env'),path.join(SERVER_ROOT,'.env.local'),path.join(SERVER_ROOT,'config','.env')];
const loaded=[];

function applyEnvFile(filePath){
  if(!fs.existsSync(filePath))return false;
  try{
    const raw=fs.readFileSync(filePath,'utf8').replace(/^\uFEFF/,'');
    for(const line of raw.split(/\r?\n/)){
      const t=line.trim();if(!t||t.startsWith('#'))continue;
      const i=t.indexOf('=');if(i<=0)continue;
      const key=t.slice(0,i).trim();let value=t.slice(i+1).trim();
      if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
      if(!(key in process.env))process.env[key]=value;
    }
    loaded.push(filePath);return true;
  }catch(e){console.warn('[ENV] Could not read server environment file:',e.message);return false;}
}

for(const file of candidates)applyEnvFile(file);
export const SERVER_ENV_STATUS={root:SERVER_ROOT,loaded_files:loaded.map(x=>path.relative(SERVER_ROOT,x)||'.env'),gemini_key_present:Boolean(String(process.env.GEMINI_API_KEY||'').trim())};
