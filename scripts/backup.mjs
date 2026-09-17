import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.dirname(here);const data=path.join(root,'data');const backups=path.join(root,'backups');
const src=path.join(data,'nunes-crm.sqlite');fs.mkdirSync(backups,{recursive:true});
if(!fs.existsSync(src)){console.error('No CRM database found yet. Start the CRM once before creating a backup.');process.exit(2)}
const d=new Date();const pad=n=>String(n).padStart(2,'0');const stamp=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const dir=path.join(backups,`NUNES_CRM_BACKUP_${stamp}`);fs.mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(src);await backup(db,path.join(dir,'nunes-crm.sqlite'));db.close();
fs.copyFileSync(path.join(root,'config','crm-config.json'),path.join(dir,'crm-config.json'));
fs.writeFileSync(path.join(dir,'BACKUP_INFO.txt'),`NUNES AI CRM backup\nCreated: ${d.toISOString()}\nDatabase: nunes-crm.sqlite\n`);
console.log(dir);
