import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const root=path.resolve(process.argv[2]||'.');
const dbPath=path.join(root,'data','nunes-crm.sqlite');
if(!fs.existsSync(dbPath)){
  console.log('NO_DATABASE');
  process.exit(0);
}
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const destDir=path.join(root,'backups','pre-update',stamp);
fs.mkdirSync(destDir,{recursive:true});
const destDb=path.join(destDir,'nunes-crm.sqlite');
const db=new DatabaseSync(dbPath);
try{
  db.exec('PRAGMA busy_timeout = 10000;');
  await backup(db,destDb);
} finally {
  try{db.close();}catch{}
}
for(const rel of ['.env','data/company-crm.json','data/company-crm-key.txt','data/google-drive-auth.json','data/price-source.json','data/product-intelligence.json','VERSION.txt']){
  const src=path.join(root,rel);
  if(!fs.existsSync(src))continue;
  const out=path.join(destDir,rel);
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.copyFileSync(src,out);
}
fs.writeFileSync(path.join(destDir,'BACKUP_INFO.txt'),[
  'NUNES AI CRM PRE-UPDATE BACKUP',
  `Created: ${new Date().toISOString()}`,
  `Source: ${root}`,
  `Database: ${dbPath}`,
  '',
  'This backup was created automatically before program files were updated.',
  'The live database was not replaced or reset by the updater.'
].join('\r\n'));
console.log(destDir);
