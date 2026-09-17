import fs from 'node:fs';
import path from 'node:path';
import { FileProductProvider, normalizeProductText } from '../../providers/productProviders.mjs';
import { compactModel, detectCategory, normalizeProductName } from './productNormalizer.mjs';
import { schemaForCategory } from './productSchemas.mjs';
import { uniqueSources } from './productSources.mjs';

const DEFAULT_TIMEOUT=Math.max(10000,Math.min(60000,Number(process.env.PRODUCT_RESEARCH_HTTP_TIMEOUT_MS||22000)));
const DEFAULT_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36 NunesCRMProductResearch/2.5.8';
const EXCLUDED_SPEC_KEYS=/\b(?:price|rate|cost|gst|tax|discount|seller|supplier|vendor|company|contact|phone|mobile|email|address|website|url|whatsapp|minimum order|moq|payment|delivery|shipping|packaging|stock)\b/i;
const IDENTITY_KEYS=/^(?:product(?:_name)?|item(?:_name)?|name|title|brand|make|manufacturer|model|model_no|model_number|category|product_type|type)$/i;
const META_SPEC_KEYS=/^(?:normalized_.+|source_sheet_id|sheet_name|row_number|last_synced_at|last_updated|updated_at|created_at|raw_row|__.+)$/i;

function cleanText(value='') { return String(value??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim(); }
function cleanKey(value='') { return cleanText(value).replace(/[_-]+/g,' ').replace(/\s+/g,' ').replace(/\b\w/g,c=>c.toUpperCase()); }
function clamp(n,min=0,max=100){return Math.max(min,Math.min(max,Number(n)||0));}
function normalizeModel(value=''){return compactModel(value||'');}
function tokens(value=''){return new Set(normalizeProductText(value).split(' ').filter(x=>x.length>1));}
function jaccard(a,b){const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;let hit=0;for(const t of A)if(B.has(t))hit++;return hit/Math.max(A.size,B.size);}
function parseMaybeJson(value,fallback=[]){if(Array.isArray(value))return value;if(value&&typeof value==='object')return value;try{return JSON.parse(String(value||''));}catch{return fallback;}}
function splitList(value=''){if(Array.isArray(value))return value.map(cleanText).filter(Boolean);return String(value||'').split(/\r?\n|\s*[•;]\s*/).map(cleanText).filter(Boolean);}
function isNumericish(value=''){return /\d/.test(String(value||''));}

export function buildProductSearchVariants(input={}){
  const original=cleanText(input.product_name||''); const base=cleanText(input.base_product_name||input.request_analysis?.base_product||''); const brand=cleanText(input.brand||''); const model=cleanText(input.model||''); const category=cleanText(input.category||detectCategory(original)); const capabilities=(input.requested_capabilities||input.request_analysis?.requested_capabilities||[]).map(cleanText).filter(Boolean);
  const out=[]; const add=v=>{v=cleanText(v);if(v&&!out.some(x=>normalizeProductText(x)===normalizeProductText(v)))out.push(v);};
  add(original); if(base&&capabilities.length)add(`${base} ${capabilities.join(' ')}`); if(brand&&model)add(`${brand} ${model}`); if(model)add(model); if(base)add(base); if(brand&&category)add(`${brand} ${category}`); add(category);
  const n=normalizeProductText(original);
  if(/digital manometer/.test(n)&&/(?:air flow|airflow|flow)/.test(n)){add('Digital Manometer with Airflow');add('Differential Pressure Manometer with Airflow');add('Digital Manometer Air Velocity Flow');}
  if(/freeze dryers?|lyophili[sz]er/.test(n)){add('Freeze Dryer');add('Laboratory Freeze Dryer');add('Laboratory Lyophilizer');add('Lyophilizer');}
  if(/breath alcohol|alcohol breath|breathaly[sz]er/.test(n)){add('Breath Alcohol Analyzer');add('Alcohol Breath Analyzer');add('Digital Breath Alcohol Tester');add('Breathalyzer');}
  if(/ph meter/.test(n)){add('pH Meter');add('Digital pH Meter');add('Laboratory pH Meter');}
  if(/karl fischer|karl fisher/.test(n)){add('Karl Fischer Titrator');add('Karl Fischer Moisture Titrator');add('KF Titrator');}
  if(/vibration/.test(n)){add('Vibration Meter');add('Digital Vibration Meter');}
  if(/moisture/.test(n)){add('Digital Moisture Meter');add('Moisture Meter');}
  if(/furnace/.test(n)){add('Laboratory Furnace');add('Sintering Furnace');}
  return out.slice(0,Math.max(3,Number(process.env.PRODUCT_RESEARCH_MAX_VARIANTS||7)));
}

export function scoreProductIdentity(input={},candidate={}){
  const reqName=cleanText(input.product_name||''),reqBrand=normalizeProductText(input.brand||''),reqModel=normalizeModel(input.model||'');
  const title=cleanText(candidate.product_name||candidate.title||candidate.name||''),brand=normalizeProductText(candidate.brand||''),model=normalizeModel(candidate.model||'');
  const reqCat=normalizeProductText(input.category||detectCategory(reqName)),cat=normalizeProductText(candidate.category||candidate.product_type||detectCategory(title));
  const requestedCaps=(input.requested_capabilities||input.request_analysis?.requested_capabilities||[]).map(normalizeProductText).filter(Boolean);
  let score=Math.round(jaccard(reqName,title)*45); const reasons=[];
  if(normalizeProductText(reqName)===normalizeProductText(title)){score+=28;reasons.push('exact product name');}
  if(reqBrand&&brand&&reqBrand===brand){score+=12;reasons.push('brand match');}
  if(reqModel){
    if(model&&model===reqModel){score+=55;reasons.push('exact model');}
    else if(model&&model!==reqModel){return {score:0,rejected:true,reason:`model mismatch (${candidate.model} != ${input.model})`,exact_model:false};}
    else if(normalizeProductText(title).replace(/\s+/g,'').includes(reqModel)){score+=50;reasons.push('model in title');}
    else score-=18;
  }
  if(reqCat&&cat&&reqCat===cat){score+=12;reasons.push('category match');}
  if(requestedCaps.length){const hay=normalizeProductText(`${title} ${candidate.category||''} ${candidate.product_type||''} ${candidate.description||''} ${(candidate.key_features||[]).join(' ')}`);let hits=0;for(const cap of requestedCaps){const words=cap.split(' ').filter(x=>x.length>2&&!['measurement','requirement','configuration','interface'].includes(x));if(words.some(w=>hay.includes(w)))hits++;}if(hits===requestedCaps.length){score+=12;reasons.push('requested capability match');}else if(hits===0){score-=18;reasons.push('requested capability not shown');}}
  else if(reqCat&&cat&&jaccard(reqCat,cat)>=0.5){score+=7;reasons.push('category similarity');}
  return {score:clamp(score,0,99),rejected:false,reason:reasons.join(', ')||'name/category similarity',exact_model:Boolean(reqModel&&((model&&model===reqModel)||normalizeProductText(title).replace(/\s+/g,'').includes(reqModel)))};
}

function specsFromObject(raw={},sourceType='internal',sourceUrl='',confidence=70){
  const specs=[]; const seen=new Set();
  for(const [k,v] of Object.entries(raw||{})){
    const key=String(k||'').replace(/^__/,''),value=cleanText(v);
    if(!value||IDENTITY_KEYS.test(key)||META_SPEC_KEYS.test(key)||EXCLUDED_SPEC_KEYS.test(key)||['description','features','key_features','applications','raw_row','source'].includes(key.toLowerCase()))continue;
    if(typeof v==='object')continue;
    const name=cleanKey(key);const nk=normalizeProductText(name);if(!name||seen.has(nk)||name.length>60)continue;seen.add(nk);
    specs.push({name,value,confidence,source_type:sourceType,source_url:sourceUrl,source:sourceType==='internal'?'Company Product Data':sourceType});
    if(specs.length>=28)break;
  }
  return specs;
}
function evidenceCompleteness(e={}){const specs=(e.specifications||[]).filter(x=>cleanText(x.value));return specs.length + (cleanText(e.description)?2:0) + ((e.key_features||[]).length?1:0)+((e.applications||[]).length?1:0);}
function evidenceHasCompleteProductInformation(e={}){const specs=(e.specifications||[]).filter(x=>cleanText(x.name)&&cleanText(x.value));return specs.length>=3&&Boolean(cleanText(e.description))&&splitList(e.key_features||[]).length>=3&&splitList(e.applications||[]).length>=2;}
function evidenceRecord({provider,sourceType,identity,specifications=[],description='',key_features=[],applications=[],sources=[],confidence=0,manualVerified=false,raw=null}={}){
  return {provider,source_type:sourceType,identity,specifications,description:cleanText(description),key_features:splitList(key_features),applications:splitList(applications),sources:uniqueSources(sources),confidence:clamp(confidence),manual_verified:Boolean(manualVerified),raw};
}

export class InternalProductProvider{
  constructor({db}={}){this.name='InternalProductProvider';this.db=db;}
  async research(input={}){
    if(!this.db)return {status:'UNAVAILABLE',evidence:[]};
    const rows=this.db.prepare(`SELECT * FROM products ORDER BY manual_verified DESC,id DESC LIMIT 6000`).all();const matches=[];
    for(const p of rows){const identity={product_name:p.name||'',brand:p.brand||'',model:p.model||'',category:p.category||''};const match=scoreProductIdentity(input,identity);if(match.rejected||match.score<45)continue;
      const specs=this.db.prepare('SELECT spec_key AS name,spec_value AS value,source,source_url,confidence,verification_status FROM product_specifications WHERE product_id=? AND TRIM(COALESCE(spec_value,\'\'))<>\'\' ORDER BY COALESCE(is_manual,0) DESC,id').all(p.id).map(s=>({...s,source_type:'internal'}));
      const sources=this.db.prepare('SELECT source_type AS type,source_name AS name,source_url AS url FROM product_sources WHERE product_id=? ORDER BY id').all(p.id);
      matches.push(evidenceRecord({provider:this.name,sourceType:'internal',identity,specifications:specs,description:p.description||'',key_features:parseMaybeJson(p.key_features_json,[]),applications:parseMaybeJson(p.applications_json,[]),sources:[{type:'internal',name:'Nunes Internal Product Master',url:''},...sources],confidence:match.score,manualVerified:Number(p.manual_verified||0)===1,raw:{product_id:p.id,match}}));
    }
    matches.sort((a,b)=>Number(b.manual_verified)-Number(a.manual_verified)||b.confidence-a.confidence);const best=matches[0]||null;
    const complete=Boolean(best&&best.manual_verified&&best.confidence>=88&&evidenceHasCompleteProductInformation(best));
    return {status:matches.length?'FOUND':'NOT_FOUND',evidence:matches.slice(0,5),complete,best};
  }
}

export class DriveProductProvider{
  constructor({dataDir}={}){this.name='DriveProductProvider';this.fileProvider=new FileProductProvider(dataDir);}
  async research(input={}){
    let hits=[];try{hits=this.fileProvider.search({product_name:input.product_name,requested_brand:input.brand,requested_model:input.model,required_specification:''})||[];}catch{return {status:'ERROR',evidence:[]};}
    const evidence=[];
    for(const hit of hits.slice(0,8)){
      const raw=hit.raw||{};const p=hit.product||{};const identity={product_name:p.name||raw.product_name||'',brand:p.brand||raw.brand||'',model:p.model||raw.model||'',category:p.category||raw.category||''};const match=scoreProductIdentity(input,identity);if(match.rejected||Math.max(match.score,hit.confidence||0)<40)continue;
      const specs=specsFromObject(raw,'internal','',Math.max(50,Math.min(90,Number(hit.confidence||60))));
      const sourceName=hit.source||'Connected Google Drive / Sheet / Product Master';
      evidence.push(evidenceRecord({provider:this.name,sourceType:'internal',identity,specifications:specs,description:p.description||raw.description||raw.product_description||'',key_features:p.key_features_json?parseMaybeJson(p.key_features_json,[]):(raw.key_features||raw.features||''),applications:p.applications_json?parseMaybeJson(p.applications_json,[]):(raw.applications||raw.usage_application||''),sources:[{type:'internal',name:sourceName,url:''}],confidence:Math.max(match.score,Number(hit.confidence||0)),raw:{file_row:hit.file_row,source:sourceName}}));
    }
    const best=evidence[0]||null;const complete=Boolean(best&&best.confidence>=88&&evidenceHasCompleteProductInformation(best));
    return {status:evidence.length?'FOUND':'NOT_FOUND',evidence,complete,best};
  }
}

async function fetchText(url,{timeoutMs=DEFAULT_TIMEOUT,headers={}}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const res=await fetch(url,{headers:{'user-agent':DEFAULT_UA,'accept':'text/html,application/xhtml+xml,*/*;q=0.8',...headers},redirect:'follow',signal:controller.signal});const text=await res.text();if(!res.ok){const e=new Error(`HTTP ${res.status}`);e.status=res.status;throw e;}return {text,url:res.url||url,status:res.status};}finally{clearTimeout(timer);}
}
function decodeHtml(s=''){return cleanText(String(s||'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))));}
function absoluteIndiaMartUrl(href=''){try{return new URL(href,'https://dir.indiamart.com').toString();}catch{return '';}}
function parseKeyValueText(text='',sourceUrl=''){
  const out=[];const normalized=decodeHtml(text).replace(/\s*\|\s*/g,'\n');
  for(const piece of normalized.split(/\n|\s{2,}|\s*[;•]\s*/)){
    const m=piece.match(/^([^:]{2,55}):\s*(.{1,180})$/);if(!m)continue;const name=cleanText(m[1]),value=cleanText(m[2]);if(!name||!value||EXCLUDED_SPEC_KEYS.test(name))continue;out.push({name,value,source:'IndiaMART Listing',source_type:'indiamart',source_url:sourceUrl,confidence:55});if(out.length>=24)break;
  }
  return out;
}
function walkJsonLd(node,out=[]){if(!node)return out;if(Array.isArray(node)){for(const x of node)walkJsonLd(x,out);return out;}if(typeof node!=='object')return out;const type=Array.isArray(node['@type'])?node['@type'].join(' '):String(node['@type']||'');if(/Product/i.test(type)||(/ItemList/i.test(type)&&node.itemListElement))out.push(node);for(const v of Object.values(node))if(v&&typeof v==='object')walkJsonLd(v,out);return out;}
function specsFromJsonLd(p={},url=''){
  const specs=[];const add=(name,value)=>{value=cleanText(value);if(value&&!EXCLUDED_SPEC_KEYS.test(name))specs.push({name, value, source:'IndiaMART Listing',source_type:'indiamart',source_url:url,confidence:58});};
  for(const x of Array.isArray(p.additionalProperty)?p.additionalProperty:[]){add(x.name||x.propertyID,x.value||x.valueReference);}
  if(p.material)add('Material',p.material); if(p.color)add('Color',p.color); if(p.countryOfOrigin)add('Country of Origin',p.countryOfOrigin?.name||p.countryOfOrigin);
  return specs.slice(0,28);
}
function parseIndiaMartHtml(html='',requestInput={}){
  const candidates=[];const ldRe=/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;let m;
  while((m=ldRe.exec(html))){try{for(const node of walkJsonLd(JSON.parse(m[1]))){if(/ItemList/i.test(String(node['@type']||'')))continue;const title=cleanText(node.name||node.headline||''),url=absoluteIndiaMartUrl(node.url||node['@id']||''),brand=cleanText(node.brand?.name||node.brand||''),model=cleanText(node.model||node.mpn||node.sku||''),description=decodeHtml(node.description||'');if(!title)continue;const identity={product_name:title,brand,model,category:detectCategory(title)};const match=scoreProductIdentity(requestInput,identity);if(match.rejected||match.score<25)continue;candidates.push(evidenceRecord({provider:'IndiaMartProductResearchProvider',sourceType:'indiamart',identity,specifications:[...specsFromJsonLd(node,url),...parseKeyValueText(description,url)],description,key_features:[],applications:[],sources:url?[{type:'indiamart',name:title,url}]:[],confidence:match.score,raw:{match}}));}}catch{}}
  // IndiaMART pages often expose product links without JSON-LD. Capture a conservative
  // title + surrounding public listing text, never seller contact fields.
  const anchorRe=/<a[^>]+href=["']([^"']*(?:proddetail|impcat)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;const seen=new Set();
  while((m=anchorRe.exec(html))&&candidates.length<40){const url=absoluteIndiaMartUrl(m[1]);const title=decodeHtml(m[2]);if(!title||title.length<4||seen.has(url||title))continue;seen.add(url||title);const before=Math.max(0,m.index-700),after=Math.min(html.length,anchorRe.lastIndex+1400),context=decodeHtml(html.slice(before,after));const identity={product_name:title,brand:'',model:'',category:detectCategory(title)};const match=scoreProductIdentity(requestInput,identity);if(match.rejected||match.score<28)continue;candidates.push(evidenceRecord({provider:'IndiaMartProductResearchProvider',sourceType:'indiamart',identity,specifications:parseKeyValueText(context,url),description:'',key_features:[],applications:[],sources:url?[{type:'indiamart',name:title,url}]:[],confidence:match.score,raw:{match}}));}
  const best=new Map();for(const e of candidates){const key=(e.sources?.[0]?.url||normalizeProductText(e.identity.product_name));const old=best.get(key);if(!old||e.confidence>old.confidence)best.set(key,e);}return [...best.values()].sort((a,b)=>b.confidence-a.confidence);
}

export class IndiaMartProductResearchProvider{
  constructor({enabled=String(process.env.INDIAMART_RESEARCH_ENABLED||'true').toLowerCase()!=='false',timeoutMs=Number(process.env.INDIAMART_RESEARCH_TIMEOUT_MS||DEFAULT_TIMEOUT),fetchImpl=fetch}={}){this.name='IndiaMartProductResearchProvider';this.enabled=enabled;this.timeoutMs=Math.max(10000,timeoutMs);this.fetchImpl=fetchImpl;}
  async _fetch(url){if(this.fetchImpl===fetch)return fetchText(url,{timeoutMs:this.timeoutMs});const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);try{const res=await this.fetchImpl(url,{headers:{'user-agent':DEFAULT_UA,'accept':'text/html,*/*'},redirect:'follow',signal:controller.signal});const text=await res.text();if(!res.ok)throw Object.assign(new Error(`IndiaMART HTTP ${res.status}`),{status:res.status});return {text,url:res.url||url};}finally{clearTimeout(timer);}}
  async research(input={}){
    if(!this.enabled)return {status:'DISABLED',evidence:[],variants:[]};const variants=buildProductSearchVariants(input),all=[],errors=[];const max=Math.max(2,Math.min(7,Number(process.env.INDIAMART_RESEARCH_MAX_VARIANTS||5)));
    for(const q of variants.slice(0,max)){try{const url=`https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(q)}`;const r=await this._fetch(url);for(const e of parseIndiaMartHtml(r.text,input)){e.search_query=q;all.push(e);}}catch(e){errors.push(`${q}: ${e.message}`);}}
    const filtered=[];const seen=new Set();for(const e of all.sort((a,b)=>b.confidence-a.confidence)){const key=e.sources?.[0]?.url||normalizeProductText(e.identity.product_name);if(seen.has(key))continue;seen.add(key);if(input.model&&e.confidence<70)continue;filtered.push(e);if(filtered.length>=8)break;}
    return {status:filtered.length?'FOUND':(errors.length?'ERROR':'NOT_FOUND'),evidence:filtered,variants,errors:errors.slice(0,3),complete:false,best:filtered[0]||null};
  }
}

const SEARCH_SCHEMA={type:'OBJECT',properties:{identity:{type:'OBJECT',properties:{product_name:{type:'STRING'},brand:{type:'STRING'},model:{type:'STRING'},category:{type:'STRING'}},required:['product_name','brand','model','category']},findings:{type:'ARRAY',items:{type:'OBJECT',properties:{name:{type:'STRING'},value:{type:'STRING'},source_url:{type:'STRING'},source_title:{type:'STRING'}},required:['name','value']}},description:{type:'STRING'},key_features:{type:'ARRAY',items:{type:'STRING'}},applications:{type:'ARRAY',items:{type:'STRING'}},sources:{type:'ARRAY',items:{type:'OBJECT',properties:{title:{type:'STRING'},url:{type:'STRING'}},required:['title','url']}}},required:['identity','findings','sources']};
function extractGeminiText(body={}){return body?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('\n')||'';}
function extractGrounding(body={}){return uniqueSources((body?.candidates?.[0]?.groundingMetadata?.groundingChunks||[]).map(x=>({type:'other',name:x?.web?.title||'Online source',url:x?.web?.uri||''})).filter(x=>x.url));}
async function geminiGroundedJson({apiKey,model,baseUrl,timeoutMs,prompt,fetchImpl=fetch}){
  if(!apiKey)return null;
  const configured=String(process.env.GEMINI_FALLBACK_MODELS||'').split(',').map(x=>x.trim()).filter(Boolean);
  const models=[...new Set([model,...configured,'gemini-flash-latest','gemini-3.5-flash','gemini-3.1-flash-lite','gemini-2.5-flash-lite','gemini-2.5-flash'].filter(Boolean))];
  let lastError=null;
  for(const modelName of models){
    const url=`${String(baseUrl).replace(/\/$/,'')}/models/${encodeURIComponent(modelName)}:generateContent`;
    const bodies=[
      {contents:[{role:'user',parts:[{text:prompt}]}],tools:[{google_search:{}}],generationConfig:{responseMimeType:'application/json',responseSchema:SEARCH_SCHEMA}},
      {contents:[{role:'user',parts:[{text:prompt}]}],tools:[{google_search:{}}],generationConfig:{responseMimeType:'application/json'}},
      {contents:[{role:'user',parts:[{text:prompt}]}],tools:[{google_search:{}}]}
    ];
    for(const body of bodies){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const res=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':apiKey},body:JSON.stringify(body),signal:controller.signal});
        const text=await res.text();
        if(!res.ok){const err=Object.assign(new Error(`Gemini grounded search failed (${res.status})`),{status:res.status});lastError=err;if([400,404].includes(res.status))continue;throw err;}
        const parsed=JSON.parse(text);let content=extractGeminiText(parsed).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');const s=content.indexOf('{'),e=content.lastIndexOf('}');if(s>=0&&e>s)content=content.slice(s,e+1);return {data:JSON.parse(content),grounding:extractGrounding(parsed),model:modelName};
      }catch(e){lastError=e;if(![400,404].includes(Number(e?.status||0)))throw e;}
      finally{clearTimeout(timer);}
    }
  }
  throw lastError||new Error('Gemini grounded search failed');
}
class GroundedWebResearchProvider{
  constructor(name,{apiKey=process.env.GEMINI_API_KEY||'',model=process.env.GEMINI_MODEL||'gemini-flash-latest',baseUrl=process.env.GEMINI_API_BASE_URL||'https://generativelanguage.googleapis.com/v1beta',timeoutMs=Number(process.env.GEMINI_TIMEOUT_MS||45000),fetchImpl=fetch,mode='public'}={}){this.name=name;this.apiKey=String(apiKey||'').trim();this.model=model;this.baseUrl=baseUrl;this.timeoutMs=Math.max(15000,timeoutMs);this.fetchImpl=fetchImpl;this.mode=mode;}
  isConfigured(){return Boolean(this.apiKey&&this.fetchImpl);}
  async research(input={}){
    if(!this.isConfigured())return {status:'NOT_CONFIGURED',evidence:[]};const exact=cleanText(input.product_name);const searchFocus=this.mode==='manufacturer'?`Search for OFFICIAL MANUFACTURER information, official datasheets, manuals and authorized distributor technical pages for this exact product. Prefer exact brand/model. Exclude IndiaMART and marketplace-only pages.`:`Search reliable public technical product pages for this exact product or category. Exclude IndiaMART because it is handled separately. Prefer technical catalogues, manuals, reputable distributors and institutional/product documentation.`;
    const prompt=`You are a technical evidence-retrieval engine. ${searchFocus}\nRequested product: ${exact}\nDetected brand: ${input.brand||''}\nDetected model: ${input.model||''}\nDetected category: ${input.category||''}\nSearch phrases should include exact product name, brand + model, model number, datasheet, manual, technical specifications and catalogue.\nCRITICAL: if an exact model is supplied, do not return specifications from any different model. Do not invent numeric specifications. Return only evidence actually supported by search results. Return JSON.`;
    try{const r=await geminiGroundedJson({apiKey:this.apiKey,model:this.model,baseUrl:this.baseUrl,timeoutMs:this.timeoutMs,prompt,fetchImpl:this.fetchImpl});const d=r?.data||{};const identity=d.identity||{product_name:exact,brand:input.brand||'',model:input.model||'',category:input.category||''};const match=scoreProductIdentity(input,identity);if(match.rejected)return {status:'NOT_FOUND',evidence:[]};const srcType=this.mode==='manufacturer'?'manufacturer':'other';const declared=(d.sources||[]).map(x=>({type:srcType,name:x.title||srcType,url:x.url||''}));const grounding=(r.grounding||[]).map(x=>({...x,type:srcType}));const trusted=new Set([...declared,...grounding].map(x=>x.url).filter(Boolean));const specs=(d.findings||[]).map(x=>({name:cleanText(x.name),value:cleanText(x.value),source:x.source_title||this.name,source_type:srcType,source_url:String(x.source_url||''),confidence:srcType==='manufacturer'?88:72})).filter(x=>x.name&&x.value&&(!x.source_url||trusted.has(x.source_url)));const ev=evidenceRecord({provider:this.name,sourceType:srcType,identity,specifications:specs,description:d.description||'',key_features:d.key_features||[],applications:d.applications||[],sources:[...declared,...grounding],confidence:Math.max(match.score,srcType==='manufacturer'?82:68),raw:{match}});return {status:(specs.length||ev.sources.length)?'FOUND':'NOT_FOUND',evidence:[ev],complete:false,best:ev};}catch(e){return {status:'ERROR',evidence:[],errors:[e.message]};}
  }
}
export class ManufacturerSearchProvider extends GroundedWebResearchProvider{constructor(opts={}){super('ManufacturerSearchProvider',{...opts,mode:'manufacturer'});}}
export class PublicWebProductProvider extends GroundedWebResearchProvider{constructor(opts={}){super('PublicWebProductProvider',{...opts,mode:'public'});}}

export function compactResearchEvidence(groups=[],input={}){
  const sourcePriority={internal:100,manufacturer:90,other:70,indiamart:60};const flat=[];
  for(const g of groups)for(const e of g?.evidence||[]){const match=scoreProductIdentity(input,e.identity||{});if(match.rejected)continue;flat.push({...e,identity_match:match.score});}
  flat.sort((a,b)=>(sourcePriority[b.source_type]||0)-(sourcePriority[a.source_type]||0)||b.identity_match-a.identity_match||b.confidence-a.confidence);
  const out=[],seen=new Set();for(const e of flat){const key=`${e.source_type}|${normalizeProductText(e.identity?.product_name||'')}|${normalizeModel(e.identity?.model||'')}`;if(seen.has(key)&&e.source_type!=='indiamart')continue;seen.add(key);out.push({...e,specifications:(e.specifications||[]).slice(0,28),raw:undefined});if(out.length>=12)break;}return out;
}

export function directRecordFromEvidence(input,e){
  if(!e)return null;
  const identity={product_name:e.identity?.product_name||input.product_name,brand:e.identity?.brand||input.brand||'',model:e.identity?.model||input.model||'',category:e.identity?.category||input.category||detectCategory(input.product_name),confidence:Math.max(75,Number(e.confidence||0))};
  const description=cleanText(e.description||'');
  const request_analysis={...(input.request_analysis||{}),questions_to_confirm:input.request_analysis?.questions_to_confirm||[],sales_pitch:input.request_analysis?.sales_pitch||''};
  return {status:'OK',provider:e.provider||'Product Research',used_search:false,content_format_version:'3.0.0',product_intelligence_version:'V3_REQUEST_AWARE',generation_status:'COMPLETE',direct_product_id:e.raw?.product_id||null,identity,request_analysis,specifications:(e.specifications||[]).map(x=>({...x,verification_status:e.manual_verified?'VERIFIED':(x.verification_status||'AI NORMALIZED')})),description,features:e.key_features||[],applications:e.applications||[],sources:e.sources||[],research_trace:[e.provider],direct_evidence:true};
}
