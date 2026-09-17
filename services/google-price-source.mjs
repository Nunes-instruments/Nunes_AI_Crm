import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const XLSX_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const GSHEET_MIME='application/vnd.google-apps.spreadsheet';
const DEFAULT_FETCH_TIMEOUT_MS=Math.max(30000,Math.min(120000,Number(process.env.GOOGLE_SHEET_TIMEOUT_MS||60000)));

export function parseGoogleSourceUrl(input=''){
  const raw=String(input||'').trim();
  if(!raw) throw new Error('Paste a Google Drive or Google Sheet link.');
  let u;try{u=new URL(raw)}catch{throw new Error('Enter a valid Google Drive or Google Sheet link.');}
  const host=u.hostname.toLowerCase();
  if(!host.endsWith('google.com')&&!host.endsWith('googleusercontent.com')) throw new Error('Only Google Drive / Google Sheet links are supported here.');
  const resourceKey=String(u.searchParams.get('resourcekey')||'').trim();
  const gid=String(u.searchParams.get('gid')||u.hash.match(/(?:^|[&#])gid=(\d+)/)?.[1]||'').trim();
  let m=u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if(m)return {kind:'sheet',id:m[1],url:raw,resourceKey,gid};
  m=u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if(m)return {kind:'drive',id:m[1],url:raw,resourceKey,gid};
  const id=u.searchParams.get('id');
  if(id)return {kind:'drive',id,url:raw,resourceKey,gid};
  throw new Error('Could not recognize the Google file ID from this link.');
}

export function isGoogleAuthorizationError(error){
  const status=Number(error?.status||0),msg=String(error?.message||'').toLowerCase();
  return status===401||status===403||/authorization|required permission|permission denied|not publicly|sign in|login required/.test(msg);
}

function xmlDecode(s=''){
  return String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'\"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function stripTags(s=''){return xmlDecode(String(s).replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();}
function findEocd(buf){for(let i=buf.length-22;i>=Math.max(0,buf.length-70000);i--)if(buf.readUInt32LE(i)===0x06054b50)return i;return -1;}
function unzipEntries(buf){
  if(!Buffer.isBuffer(buf)||buf.length<22)throw new Error('Invalid XLSX file.');
  const eocd=findEocd(buf);if(eocd<0)throw new Error('XLSX ZIP directory not found.');
  const count=buf.readUInt16LE(eocd+10),offset=buf.readUInt32LE(eocd+16);let p=offset;const out=new Map();
  for(let i=0;i<count&&p+46<=buf.length;i++){
    if(buf.readUInt32LE(p)!==0x02014b50)break;
    const method=buf.readUInt16LE(p+10),comp=buf.readUInt32LE(p+20),nameLen=buf.readUInt16LE(p+28),extraLen=buf.readUInt16LE(p+30),commentLen=buf.readUInt16LE(p+32),local=buf.readUInt32LE(p+42);
    const name=buf.slice(p+46,p+46+nameLen).toString('utf8');
    if(local+30<=buf.length&&buf.readUInt32LE(local)===0x04034b50){
      const ln=buf.readUInt16LE(local+26),le=buf.readUInt16LE(local+28),start=local+30+ln+le,end=start+comp;let data=buf.slice(start,end);
      if(method===8)data=inflateRawSync(data);else if(method!==0)throw new Error(`Unsupported XLSX ZIP compression method ${method}.`);
      out.set(name,data);
    }
    p+=46+nameLen+extraLen+commentLen;
  }
  return out;
}
function colIndex(ref='A1'){
  const m=String(ref).match(/^([A-Z]+)/i);if(!m)return 0;let n=0;for(const ch of m[1].toUpperCase())n=n*26+(ch.charCodeAt(0)-64);return n-1;
}
function excelDateToIso(v){const n=Number(v);if(!Number.isFinite(n)||n<20000||n>100000)return v;const ms=Math.round((n-25569)*86400000);const d=new Date(ms);return Number.isFinite(d.getTime())?d.toISOString().slice(0,10):v;}
function headerKey(v=''){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function keyName(v=''){return headerKey(v).replace(/ /g,'_');}
function normalizeSearch(v=''){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
const HEADER_HINTS=new Set(['product','product name','item','item name','model','model no','model number','brand','make','price','rate','unit price','selling price','sale price','purchase price','buying price','last purchase price','last selling price','quoted price','previous quoted price','supplier','vendor','date','price date','gst','tax','stock','availability','category','product code','item code','phone','contact']);
function headerScore(row=[]){return row.reduce((n,v)=>n+(HEADER_HINTS.has(headerKey(v))?3:(headerKey(v).includes('price')||headerKey(v).includes('product')||headerKey(v).includes('model')?1:0)),0);}
function rowsToObjects(matrix=[],sheetName='Sheet'){
  if(!Array.isArray(matrix)||!matrix.length)return [];
  let hi=0,best=-1;for(let i=0;i<Math.min(30,matrix.length);i++){const s=headerScore(matrix[i]);if(s>best){best=s;hi=i;}}
  if(best<=0)return [];
  const rawHeaders=(matrix[hi]||[]).map((v,i)=>String(v||'').trim()||`Column ${i+1}`);const seen=new Map();
  const headers=rawHeaders.map((h,i)=>{let k=keyName(h)||`column_${i+1}`;const c=(seen.get(k)||0)+1;seen.set(k,c);if(c>1)k=`${k}_${c}`;return k;});
  const dateCols=new Set(headers.map((h,i)=>/(^|_)date($|_)/.test(h)?i:-1).filter(i=>i>=0));
  const out=[];for(let rowOffset=hi+1;rowOffset<matrix.length;rowOffset++){
    const row=matrix[rowOffset];if(!row||!row.some(v=>String(v??'').trim()))continue;const obj={};headers.forEach((h,i)=>{let v=row[i]??'';if(dateCols.has(i))v=excelDateToIso(v);obj[h]=String(v??'').trim();});obj.__sheet=sheetName;obj.__row_number=rowOffset+1;out.push(obj);
  }return out;
}
export function parseCsvMatrix(text=''){
  const rows=[];let row=[],cell='',quoted=false;const s=String(text||'').replace(/^\uFEFF/,'');
  for(let i=0;i<s.length;i++){
    const ch=s[i];if(ch==='"'){if(quoted&&s[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(ch===','&&!quoted){row.push(cell);cell='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&s[i+1]==='\n')i++;row.push(cell);if(row.some(x=>String(x).trim()))rows.push(row);row=[];cell='';}
    else cell+=ch;
  }
  if(cell||row.length){row.push(cell);if(row.some(x=>String(x).trim()))rows.push(row);}return rows;
}
export function parseXlsx(buffer){
  const zip=unzipEntries(buffer),shared=[];const ss=zip.get('xl/sharedStrings.xml');
  if(ss){const xml=ss.toString('utf8');for(const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)){const parts=[...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>xmlDecode(x[1]));shared.push(parts.join(''));}}
  const workbook=zip.get('xl/workbook.xml')?.toString('utf8')||'';const rels=zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8')||'';const relMap=new Map();
  for(const m of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)){const a=m[1],rid=a.match(/\bId="([^"]+)"/)?.[1],rawTarget=a.match(/\bTarget="([^"]+)"/)?.[1];if(!rid||!rawTarget)continue;let target=rawTarget.replace(/^\//,'');if(!target.startsWith('xl/'))target=`xl/${target.replace(/^\.\//,'')}`;relMap.set(rid,target);}
  let sheets=[];for(const m of workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)){const a=m[1],name=xmlDecode(a.match(/name="([^"]*)"/)?.[1]||'Sheet'),rid=a.match(/r:id="([^"]+)"/)?.[1],sid=a.match(/sheetId="([^"]+)"/)?.[1];if(rid&&relMap.get(rid))sheets.push({name,id:sid,target:relMap.get(rid)});}
  if(!sheets.length){sheets=[...zip.keys()].filter(k=>/^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort().map((target,i)=>({name:`Sheet ${i+1}`,id:String(i+1),target}));}
  const all=[];const sheetMeta=[];
  for(const sh of sheets){const xml=zip.get(sh.target)?.toString('utf8');if(!xml)continue;const matrix=[];
    for(const cm of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){const attrs=cm[1],body=cm[2],ref=attrs.match(/r="([A-Z]+\d+)"/i)?.[1]||'',type=attrs.match(/t="([^"]+)"/)?.[1]||'',idx=colIndex(ref);let value='';
      if(type==='inlineStr'){value=[...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>xmlDecode(x[1])).join('');}
      else {const v=body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1]??'';value=type==='s'?shared[Number(v)]??'':type==='str'?xmlDecode(v):v;}
      const rn=Math.max(0,Number(ref.match(/(\d+)$/)?.[1]||1)-1);matrix[rn]=matrix[rn]||[];matrix[rn][idx]=value;
    }
    const rows=rowsToObjects(matrix,sh.name);all.push(...rows);sheetMeta.push({name:sh.name,rows:rows.length,indexed:rows.length>0});
  }
  return {rows:all,sheets:sheetMeta};
}

async function fetchWithTimeout(url,opts={},timeoutMs=DEFAULT_FETCH_TIMEOUT_MS){
  const ac=new AbortController();const timer=setTimeout(()=>ac.abort(new Error('timeout')),timeoutMs);
  try{return await fetch(url,{redirect:'follow',...opts,signal:ac.signal});}
  catch(e){if(e?.name==='AbortError'||String(e?.message||'').toLowerCase().includes('aborted')){const x=new Error(`Google Sheet request timed out after ${Math.round(timeoutMs/1000)} seconds.`);x.code='GOOGLE_TIMEOUT';x.status=504;throw x;}throw e;}
  finally{clearTimeout(timer);}
}
function googleErrorFromResponse(status,body=''){
  const clean=stripTags(String(body||'')).replace(/window\[[^\]]+\][\s\S]*/i,'').trim();
  let message='Google could not read this file.';let code='GOOGLE_HTTP';
  if(status===400){message='Google rejected this Sheet/Drive link. Check the link and try again.';code='GOOGLE_BAD_REQUEST';}
  else if(status===401||status===403){message='Google access is required for this file. Share it as Viewer or connect the Admin Google account.';code='GOOGLE_AUTH_REQUIRED';}
  else if(status===404){message='Google Sheet was not found or is not shared with the connected Google account. Check the Sheet link or choose another file from Google Drive.';code='GOOGLE_NOT_FOUND';}
  else if(status===429){message='Google is temporarily limiting requests. Keep the saved local price index and try Refresh Data again in a few minutes.';code='GOOGLE_RATE_LIMIT';}
  else if(status>=500){message='Google is temporarily unavailable. The CRM will keep using the last synchronized price index.';code='GOOGLE_TEMPORARY';}
  else if(clean&&clean.length<180)message=`Google returned HTTP ${status}: ${clean}`;
  const e=new Error(message);e.status=status;e.code=code;return e;
}
async function fetchBuffer(url,opts={}){
  let r;try{r=await fetchWithTimeout(url,opts);}catch(e){if(!e.status){e.status=503;e.code=e.code||'GOOGLE_NETWORK';e.message=`Google Sheet could not be reached. Check internet access on the CRM server and try again.`;}throw e;}
  if(!r.ok){const text=(await r.text()).slice(0,1200);throw googleErrorFromResponse(r.status,text);}
  return {buffer:Buffer.from(await r.arrayBuffer()),contentType:r.headers.get('content-type')||'',name:filenameFromHeaders(r.headers)||'',status:r.status};
}
function filenameFromHeaders(headers){const cd=headers.get('content-disposition')||'';return decodeURIComponent(cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1]||'').replace(/^"|"$/g,'');}
function rowsFromBuffer(buffer,contentType='',name='source'){
  const lower=String(name||'').toLowerCase();if(buffer.slice(0,2).toString()==='PK'||contentType.includes('spreadsheetml')||lower.endsWith('.xlsx'))return parseXlsx(buffer);
  const text=buffer.toString('utf8').replace(/^\uFEFF/,'');if(contentType.includes('json')||lower.endsWith('.json')){const j=JSON.parse(text);const rows=Array.isArray(j)?j:(Array.isArray(j.rows)?j.rows:[]);return {rows:rows.map((x,i)=>({...x,__sheet:x.__sheet||'Data',__row_number:x.__row_number||i+2})),sheets:[{name:'Data',rows:rows.length,indexed:rows.length>0}]};}
  const matrix=parseCsvMatrix(text);const rows=rowsToObjects(matrix,'Data');return {rows,sheets:[{name:'Data',rows:rows.length,indexed:rows.length>0}]};
}


function columnLetters(n){let x=Math.max(1,Number(n)||1),out='';while(x){x--;out=String.fromCharCode(65+(x%26))+out;x=Math.floor(x/26);}return out;}
function quotedSheetName(name=''){return `'${String(name||'Sheet').replace(/'/g,"''")}'`;}
async function fetchJson(url,opts={}){
  let r;try{r=await fetchWithTimeout(url,opts);}catch(e){if(!e.status){e.status=503;e.code=e.code||'GOOGLE_NETWORK';e.message='Google could not be reached from the CRM server.';}throw e;}
  if(!r.ok){const text=(await r.text()).slice(0,1200);throw googleErrorFromResponse(r.status,text);}
  return await r.json();
}
async function loadGoogleSheetViaSheetsApi(source,headers){
  const fields='spreadsheetId,properties(title),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount)))';
  const meta=await fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.id)}?includeGridData=false&fields=${encodeURIComponent(fields)}`,{headers});
  const sheetDefs=(meta.sheets||[]).map(x=>x.properties||{}).filter(x=>x.title&&!x.hidden);
  const all=[];const sheets=[];
  for(const sh of sheetDefs){
    const rowCount=Math.max(1,Math.min(250000,Number(sh.gridProperties?.rowCount||5000)));
    const colCount=Math.max(1,Math.min(150,Number(sh.gridProperties?.columnCount||30)));
    const endCol=columnLetters(colCount),matrix=[],chunkSize=5000;
    for(let start=1;start<=rowCount;start+=chunkSize){
      const end=Math.min(rowCount,start+chunkSize-1),range=`${quotedSheetName(sh.title)}!A${start}:${endCol}${end}`;
      const j=await fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,{headers});
      const values=Array.isArray(j.values)?j.values:[];
      if(!values.length){if(start===1)break;else break;}
      matrix.push(...values);
      if(values.length<chunkSize)break;
    }
    const rows=rowsToObjects(matrix,sh.title);all.push(...rows);sheets.push({name:sh.title,rows:rows.length,indexed:rows.length>0,sheet_id:sh.sheetId});
  }
  return {kind:'sheet',id:source.id,url:source.url,name:meta.properties?.title||'Google Sheet',mimeType:GSHEET_MIME,modifiedTime:null,rows:all,sheets,readMethod:'google-sheets-api'};
}
async function tryPublicGoogleSheet(source){
  const suffix=source.resourceKey?`&resourcekey=${encodeURIComponent(source.resourceKey)}`:'';
  const attempts=[];
  attempts.push(async()=>{const x=await fetchBuffer(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(source.id)}/export?format=xlsx${suffix}`);if(x.contentType.includes('text/html')&&x.buffer.slice(0,2).toString()!=='PK')throw Object.assign(new Error('Google access is required for this file.'),{status:403,code:'GOOGLE_AUTH_REQUIRED'});const parsed=parseXlsx(x.buffer);return {kind:'sheet',id:source.id,url:source.url,name:x.name||'Google Sheet',mimeType:GSHEET_MIME,...parsed,readMethod:'public-xlsx'};});
  const gid=source.gid||'0';
  attempts.push(async()=>{const x=await fetchBuffer(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(source.id)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}${source.resourceKey?`&resourcekey=${encodeURIComponent(source.resourceKey)}`:''}`);const matrix=parseCsvMatrix(x.buffer.toString('utf8'));const rows=rowsToObjects(matrix,'Sheet');if(!rows.length)throw new Error('The Google Sheet opened but no recognizable product rows were found.');return {kind:'sheet',id:source.id,url:source.url,name:'Google Sheet',mimeType:'text/csv',rows,sheets:[{name:'Sheet',rows:rows.length,indexed:true}],readMethod:'public-gviz'};});
  let last=null;
  for(const fn of attempts){try{return await fn()}catch(e){last=e;}}
  const e=new Error(last?.code==='GOOGLE_NOT_FOUND'?'This Google Sheet cannot be opened with the current link. It may be private, deleted, moved, or the Sheet ID may be wrong. Share it as Viewer or connect the Admin Google account.':(last?.message||'Google Sheet could not be read.'));
  e.status=(last?.status===404||last?.status===401||last?.status===403)?403:Number(last?.status||502);e.code=last?.code||'GOOGLE_ACCESS';return Promise.reject(e);
}

export async function loadGooglePriceSource(source,{accessToken=''}={}){
  const headers=accessToken?{Authorization:`Bearer ${accessToken}`}:{},meta={kind:source.kind,id:source.id,url:source.url};
  if(source.kind==='sheet'){
    if(accessToken){
      try{return await loadGoogleSheetViaSheetsApi(source,headers)}catch(apiError){
        if(apiError?.status===404)throw apiError;
        try{
          const mr=await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(source.id)}?fields=id,name,mimeType,modifiedTime`,{headers});if(!mr.ok)throw googleErrorFromResponse(mr.status,await mr.text());const fm=await mr.json();
          if(fm.mimeType!==GSHEET_MIME)throw new Error('The Google Sheet link did not resolve to a spreadsheet.');
          const x=await fetchBuffer(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(source.id)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`,{headers});const parsed=parseXlsx(x.buffer);return {...meta,name:fm.name||'Google Sheet',mimeType:fm.mimeType,modifiedTime:fm.modifiedTime||null,...parsed,readMethod:'drive-export'};
        }catch(exportError){throw apiError?.status?apiError:exportError;}
      }
    }
    return await tryPublicGoogleSheet(source);
  }
  if(accessToken){
    const mr=await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(source.id)}?fields=id,name,mimeType,modifiedTime`,{headers});if(!mr.ok)throw googleErrorFromResponse(mr.status,await mr.text());const fm=await mr.json();
    if(fm.mimeType===GSHEET_MIME)return await loadGoogleSheetViaSheetsApi({...source,kind:'sheet'},headers);
    const x=await fetchBuffer(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(source.id)}?alt=media`,{headers});const parsed=rowsFromBuffer(x.buffer,x.contentType,fm.name||x.name||'Drive file');return {...meta,name:fm.name||x.name||'Google Drive file',mimeType:fm.mimeType||x.contentType,modifiedTime:fm.modifiedTime||null,...parsed,readMethod:'drive-api'};
  }
  const rk=source.resourceKey?`&resourcekey=${encodeURIComponent(source.resourceKey)}`:'';
  const x=await fetchBuffer(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(source.id)}${rk}`);if(x.contentType.includes('text/html'))throw Object.assign(new Error('This Google Drive file is not publicly downloadable. Share it as Viewer or connect the Admin Google account.'),{status:403,code:'GOOGLE_AUTH_REQUIRED'});const parsed=rowsFromBuffer(x.buffer,x.contentType,x.name||'Google Drive file');return {...meta,name:x.name||'Google Drive file',mimeType:x.contentType,...parsed,readMethod:'public-drive-download'};
}

function pick(row,names=[]){for(const n of names){const v=row?.[n];if(v!==undefined&&v!==null&&String(v).trim()!=='')return String(v).trim();}return '';}
function canonicalRow(row,result,index,syncedAt,sourceName){
  const base=Object.fromEntries(Object.entries(row||{}).map(([k,v])=>[keyName(k),v]));
  const product=pick(base,['product_name','product','item_name','item','material_name','description']);
  const brand=pick(base,['brand','make','manufacturer']);
  const model=pick(base,['model','model_no','model_number','model_name_number']);
  const code=pick(base,['product_code','item_code','internal_code','product_id','code','sku']);
  const sheet=String(row?.__sheet||base.__sheet||'Data');
  const rowNumber=Number(row?.__row_number||base.__row_number||index+2);
  return {...base,
    source_sheet_id:result.id||'',sheet_name:sheet,row_number:rowNumber,
    product_name:product,normalized_product_name:normalizeSearch(product),brand,normalized_brand:normalizeSearch(brand),model,normalized_model:normalizeSearch(model).replace(/\s+/g,''),product_code:code,normalized_product_code:normalizeSearch(code).replace(/\s+/g,''),
    purchase_price:pick(base,['last_purchase_price','purchase_price','buying_price','buy_price','cost_price','cost']),selling_price:pick(base,['last_selling_price','selling_price','sale_price','unit_price','price','rate']),quoted_price:pick(base,['previous_quoted_price','quoted_price','quote_price','previous_quote']),supplier:pick(base,['supplier','vendor','company']),gst:pick(base,['gst_percent','gst','tax']),date:pick(base,['price_date','date','updated_at','quotation_date']),stock:pick(base,['stock_status','stock','availability']),category:pick(base,['category','product_category']),
    source:pick(base,['source'])||`${sourceName}${sheet?` • ${sheet}`:''}`,last_synced_at:syncedAt
  };
}
function atomicJson(file,data){const tmp=`${file}.tmp`;fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,file);}
function atomicJsonPretty(file,data){const tmp=`${file}.tmp`;fs.writeFileSync(tmp,JSON.stringify(data,null,2));fs.renameSync(tmp,file);}

export function writePriceIndex(dataDir,result,sourceUrl){
  const clean=(result.rows||[]).filter(r=>r&&typeof r==='object');if(!clean.length)throw new Error('No usable product/price rows were found in the connected Google file.');
  const sourceName=result.name||'Google Price Source',syncedAt=new Date().toISOString();const indexed=clean.map((r,i)=>canonicalRow(r,result,i,syncedAt,sourceName)).filter(r=>r.product_name||r.model||r.product_code);
  if(!indexed.length)throw new Error('The Google Sheet was readable, but no recognizable product rows were found. Check that it contains Product/Item/Model headings.');
  const file=path.join(dataDir,'product-master.json');atomicJson(file,indexed);
  const sheets=result.sheets||[];const meta={connected:true,state:'CONNECTED',index_ready:true,using_cached:false,url:sourceUrl,id:result.id,kind:result.kind,name:sourceName,mime_type:result.mimeType||'',read_method:result.readMethod||'',source_kind:result.kind||'',rows:indexed.length,sheets,sheets_detected:sheets.length,sheets_indexed:sheets.filter(x=>Number(x.rows||0)>0).length,modified_time:result.modifiedTime||null,last_updated:syncedAt,last_successful_sync:syncedAt,last_error:null,index_file:'product-master.json'};
  atomicJsonPretty(path.join(dataDir,'price-source.json'),meta);return meta;
}
export function readPriceSourceStatus(dataDir){
  let s={};try{s=JSON.parse(fs.readFileSync(path.join(dataDir,'price-source.json'),'utf8'));}catch{}
  const indexFile=path.join(dataDir,'product-master.json'),indexReady=fs.existsSync(indexFile)&&Number(s.rows||0)>0;
  return {connected:Boolean(s.connected),state:s.state|| (indexReady?'CONNECTED':'DISCONNECTED'),index_ready:indexReady,using_cached:Boolean(s.using_cached),rows:Number(s.rows||0),sheets:Array.isArray(s.sheets)?s.sheets:[],...s,index_ready:indexReady};
}
export function writePriceSourceStatus(dataDir,patch={}){
  const current=readPriceSourceStatus(dataDir);const next={...current,...patch};atomicJsonPretty(path.join(dataDir,'price-source.json'),next);return next;
}
export function readGoogleAuth(authPath){try{return JSON.parse(fs.readFileSync(authPath,'utf8'));}catch{return null;}}
export function writeGoogleAuth(authPath,data){atomicJsonPretty(authPath,data);}

export class GoogleSheetPriceProvider{
  constructor({dataDir,defaultUrl='',getAccessToken=async()=>null,oauthConfigured=()=>false,searchProducts=null,logger=console}={}){this.dataDir=dataDir;this.defaultUrl=String(defaultUrl||'').trim();this.getAccessToken=getAccessToken;this.oauthConfigured=oauthConfigured;this.searchAdapter=typeof searchProducts==='function'?searchProducts:null;this.logger=logger;}
  getStatus(){return {...readPriceSourceStatus(this.dataDir),default_url:this.defaultUrl||null};}
  getMetadata(){return this.getStatus();}
  async testConnection(link){const source=parseGoogleSourceUrl(link);let result;try{result=await loadGooglePriceSource(source);}catch(e){if(!isGoogleAuthorizationError(e))throw e;const token=await this.getAccessToken();if(!token)throw e;result=await loadGooglePriceSource(source,{accessToken:token});}return {id:result.id,name:result.name,kind:result.kind,rows:Number(result.rows?.length||0),sheets:result.sheets||[]};}
  async _sync(link,state){
    const source=parseGoogleSourceUrl(link),startedAt=new Date().toISOString();
    writePriceSourceStatus(this.dataDir,{state,active_url:link,sync_started_at:startedAt,last_error:null});
    let result=null,publicError=null;
    try{result=await loadGooglePriceSource(source);}catch(e){publicError=e;}
    if(!result&&isGoogleAuthorizationError(publicError)){
      const token=await this.getAccessToken();
      if(token){try{result=await loadGooglePriceSource(source,{accessToken:token});}catch(e){publicError=e;}}
    }
    if(!result){
      const authRequired=isGoogleAuthorizationError(publicError);const current=readPriceSourceStatus(this.dataDir);const safeError=String(publicError?.message||'Google Sheet connection failed.');
      this.logger?.error?.('[PRICE SOURCE]',{sheet_id:source.id,http_status:Number(publicError?.status||0)||null,error_code:publicError?.code||null,message:safeError});
      const nextState=authRequired?'AUTH REQUIRED':(publicError?.code==='GOOGLE_NOT_FOUND'?'NOT FOUND':'ERROR');
      writePriceSourceStatus(this.dataDir,{connected:false,state:nextState,index_ready:current.index_ready,using_cached:Boolean(current.index_ready),url:current.url||link,pending_url:link,last_error:safeError,last_error_code:publicError?.code||null,last_failed_sync:new Date().toISOString(),sync_started_at:null});
      const err=new Error(safeError);err.authorization_required=authRequired;err.oauth_configured=Boolean(this.oauthConfigured());err.status=authRequired?403:Number(publicError?.status||502);err.code=publicError?.code||null;throw err;
    }
    const meta=writePriceIndex(this.dataDir,result,link);return {...meta,default_url:this.defaultUrl||null};
  }
  connect(link){return this._sync(link,'CONNECTING');}
  sync(link){return this._sync(link,'REFRESHING');}
  searchProducts(requirement={}){return this.searchAdapter?this.searchAdapter(requirement):[];}
}
