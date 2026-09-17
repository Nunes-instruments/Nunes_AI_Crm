import { ProductIntelligenceProvider } from './ProductIntelligenceProvider.mjs';
import { detectBrand, detectCategory, detectModel } from './productNormalizer.mjs';
import { identityConfidence, looksPreciseTechnicalValue } from './productConfidence.mjs';
import { schemaForCategory } from './productSchemas.mjs';
import { uniqueSources } from './productSources.mjs';

export const PRODUCT_INTELLIGENCE_VERSION='V3_REQUEST_AWARE';

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function wordCount(value=''){return String(value||'').trim().split(/\s+/).filter(Boolean).length;}
function extractJson(text='') {
  let s=String(text||'').trim();
  if (s.startsWith('```')) s=s.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const start=s.indexOf('{'), end=s.lastIndexOf('}');
  if(start>=0&&end>start)s=s.slice(start,end+1);
  return JSON.parse(s);
}
function textFromResponse(body={}) { return body?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('\n') || ''; }
function groundingSources(body={}) {
  const chunks=body?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return uniqueSources(chunks.map(c=>({type:'Online Search',name:c?.web?.title||'Online source',url:c?.web?.uri||''})).filter(x=>x.url));
}

const GENERIC_PLACEHOLDER_PATTERNS=[
  /product details below are working guidance/i,
  /match the confirmed measuring range\s*\/\s*capacity/i,
  /meet the required accuracy\s*\/\s*resolution/i,
  /suitable for the stated customer application/i,
  /confirm calibration\s*\/\s*certification/i,
  /customer application to be confirmed/i,
  /confirm required range/i,
  /match customer requirement/i,
  /product details need verification/i,
  /suitable for customer application/i,
  /please verify with supplier/i,
  /exact .* should be confirmed before quotation/i,
  /requirements? should be confirmed before/i,
  /^\s*model dependent\s*$/i,
  /^\s*to be confirmed\s*$/i,
  /^\s*not available\s*$/i
];
function isGenericPlaceholder(value=''){
  const s=String(value||'').trim();
  return Boolean(s)&&GENERIC_PLACEHOLDER_PATTERNS.some(re=>re.test(s));
}
function cleanText(value=''){
  const s=String(value??'').replace(/^\s*[•\-*]+\s*/,'').trim();
  return s&&!isGenericPlaceholder(s)?s:'';
}
function cleanDescription(value=''){
  const raw=String(value??'').trim();
  if(!raw)return '';
  const parts=raw.split(/\r?\n+/).map(x=>cleanText(x)).filter(Boolean);
  const text=parts.join(' ').replace(/\s+/g,' ').trim();
  return text&&!isGenericPlaceholder(text)?text:'';
}
function cleanList(value,limit=16){
  const arr=Array.isArray(value)?value:(value==null?[]:[value]);
  const out=[];
  for(const item of arr){
    const parts=typeof item==='string'&&/[\r\n]/.test(item)?item.split(/\r?\n+/):[item];
    for(const p of parts){const s=cleanText(p);if(s&&!out.includes(s))out.push(s);if(out.length>=limit)return out;}
  }
  return out;
}
function evidencePairKey(name='',value=''){
  return `${String(name||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}::${String(value||'').toLowerCase().replace(/[^a-z0-9.%°+\-\/]+/g,'').trim()}`;
}
function normalizeSpec(raw={},trustedUrls=new Set(),evidencePairs=new Set()) {
  const name=cleanText(raw.name||raw.specification||'');
  let value=cleanText(raw.value??'');
  let sourceUrl=String(raw.source_url||raw.url||'').trim();
  const source=String(raw.source||raw.source_name||'').trim();
  const sourceType=String(raw.source_type||raw.type||'other').trim().toLowerCase();
  let verification=String(raw.verification_status||raw.status||'').trim().toUpperCase();
  let confidence=Math.max(0,Math.min(100,Math.round(Number(raw.confidence||0)*((Number(raw.confidence||0)<=1)?100:1))));
  if(!name||!value)return null;
  const precise=looksPreciseTechnicalValue(value);
  const pairSupported=evidencePairs.has(evidencePairKey(name,value));
  const urlSupported=Boolean(sourceUrl)&&trustedUrls.has(sourceUrl);
  const internalSupported=sourceType==='internal'&&pairSupported;
  const supported=pairSupported||urlSupported||internalSupported;
  // Do not throw away a complete Gemini product record merely because a precise
  // value did not arrive with a URL. The prompt already forbids invented exact
  // values; unsupported precise values are retained but clearly downgraded so the
  // staff member can still see the generated specification in the requested
  // two-column product-information format.
  if(!verification)verification=supported?'VERIFIED':(precise?'NEEDS VERIFICATION':'AI NORMALIZED');
  if(!supported&&precise)confidence=confidence?Math.min(confidence,45):40;
  return {name,value,source:source||(sourceUrl?'Research Evidence':'Gemini Product Synthesis'),source_type:sourceType||'other',source_url:sourceUrl,confidence:confidence||(supported?80:55),verification_status:verification};
}
function compactEvidenceForPrompt(input={}){
  const out=[];
  for(const e of Array.isArray(input.research_evidence)?input.research_evidence:[]){
    out.push({
      provider:e.provider||'',source_type:e.source_type||'',confidence:Number(e.confidence||0),identity_match:Number(e.identity_match||0),identity:e.identity||{},
      specifications:(e.specifications||[]).slice(0,28).map(x=>({name:x.name||x.spec_key||'',value:x.value??x.spec_value??'',source_type:x.source_type||e.source_type||'',source_url:x.source_url||''})),
      description:String(e.description||'').slice(0,1800),key_features:(e.key_features||[]).slice(0,12),applications:(e.applications||[]).slice(0,12),sources:(e.sources||[]).slice(0,10)
    });
    if(out.length>=12)break;
  }
  return out;
}
function evidencePairsForInput(input={}){
  const set=new Set();
  for(const e of Array.isArray(input.research_evidence)?input.research_evidence:[])for(const x of e.specifications||[]){const n=x.name||x.spec_key||'',v=x.value??x.spec_value??'';if(String(n).trim()&&String(v).trim())set.add(evidencePairKey(n,v));}
  return set;
}
function normalizeConfidence(value){const n=Number(value||0);return Math.max(0,Math.min(100,Math.round(n<=1?n*100:n)));}

const RESPONSE_SCHEMA={
  type:'OBJECT',
  properties:{
    identity:{type:'OBJECT',properties:{product_name:{type:'STRING'},brand:{type:'STRING'},series:{type:'STRING'},model:{type:'STRING'},category:{type:'STRING'},identity_confidence:{type:'NUMBER'}},required:['product_name','brand','model','category','identity_confidence']},
    request_analysis:{type:'OBJECT',properties:{original_request:{type:'STRING'},base_product:{type:'STRING'},requested_modifier:{type:'STRING'},requested_capabilities:{type:'ARRAY',items:{type:'STRING'}},interpreted_need:{type:'STRING'},selection_focus:{type:'ARRAY',items:{type:'STRING'}},questions_to_confirm:{type:'ARRAY',items:{type:'STRING'}},sales_pitch:{type:'STRING'}},required:['original_request','base_product','requested_capabilities','interpreted_need','selection_focus','questions_to_confirm','sales_pitch']},
    specifications:{type:'ARRAY',items:{type:'OBJECT',properties:{name:{type:'STRING'},value:{type:'STRING'},confidence:{type:'NUMBER'},source_type:{type:'STRING'},source:{type:'STRING'},source_url:{type:'STRING'},verification_status:{type:'STRING'}},required:['name','value','confidence','source_type']}},
    description:{type:'STRING'},
    key_features:{type:'ARRAY',items:{type:'STRING'}},
    applications:{type:'ARRAY',items:{type:'STRING'}},
    sources:{type:'ARRAY',items:{type:'OBJECT',properties:{type:{type:'STRING'},title:{type:'STRING'},name:{type:'STRING'},url:{type:'STRING'}},required:['type','url']}}
  },required:['identity','request_analysis','specifications','description','key_features','applications','sources']
};

export function validateCompleteProductInformation(record={}){
  const specifications=(record.specifications||[]).filter(x=>cleanText(x?.name)&&cleanText(x?.value));
  const description=cleanDescription(record.description||'');
  const features=cleanList(record.features?.length?record.features:record.key_features,20);
  const applications=cleanList(record.applications,20);
  const missing=[];
  if(specifications.length<3)missing.push('Specifications');
  if(!description)missing.push('Product Description');
  if(features.length<3)missing.push('Key Features');
  if(applications.length<2)missing.push('Applications');
  const generic=[description,...features,...applications,...specifications.flatMap(x=>[x.name,x.value])].filter(Boolean).some(isGenericPlaceholder);
  if(generic)missing.push('Generic placeholder content');
  return {ok:missing.length===0,missing:[...new Set(missing)],counts:{specifications:specifications.length,description_words:wordCount(description),key_features:features.length,applications:applications.length}};
}

function hasUsableApiKey(value=''){
  const key=String(value||'').trim();
  if(!key||key.length<12)return false;
  return !/^(?:YOUR(?:[_ -].*)?|PASTE|REPLACE|EXAMPLE|CHANGEME)/i.test(key);
}
function errorCode(error){
  const status=Number(error?.status||0);
  if(error?.name==='AbortError'||error?.code==='TIMEOUT')return 'TIMEOUT';
  if(status===401||status===403||/api[_ ]?key.*(?:invalid|not valid|rejected)/i.test(String(error?.apiMessage||error?.message||'')))return 'AUTHENTICATION_FAILED';
  if(status===404)return 'MODEL_NOT_FOUND';
  if(status===429)return 'RATE_LIMITED';
  if(error instanceof SyntaxError||error?.code==='INVALID_RESPONSE')return 'INVALID_RESPONSE';
  if(status>=400||error?.code==='API_REQUEST_FAILED')return 'API_REQUEST_FAILED';
  return 'API_REQUEST_FAILED';
}
function safeErrorMessage(code,status=0){
  if(code==='AUTHENTICATION_FAILED')return 'Gemini authentication failed. Run CONFIGURE_PRODUCT_INTELLIGENCE.bat, paste a valid Google AI Studio Gemini API key, test it, and restart the CRM.';
  if(code==='RATE_LIMITED')return 'Gemini rate limit reached. Product research can be retried shortly.';
  if(code==='MODEL_NOT_FOUND')return 'The configured Gemini model is not available for this API key. Run CONFIGURE_PRODUCT_INTELLIGENCE.bat to refresh the model settings.';
  if(code==='INVALID_RESPONSE')return 'Gemini returned an incomplete or invalid product-information response.';
  if(code==='TIMEOUT')return 'Gemini product-information request timed out.';
  if(code==='KEY_MISSING')return 'Gemini API key is missing. Run CONFIGURE_PRODUCT_INTELLIGENCE.bat and paste a Gemini API key created in Google AI Studio.';
  return status?`Gemini API request failed with HTTP ${status}.`:'Gemini API request failed.';
}

export class GeminiProductIntelligenceProvider extends ProductIntelligenceProvider {
  constructor({apiKey=process.env.GEMINI_API_KEY||'',model=process.env.GEMINI_PRODUCT_MODEL||process.env.GEMINI_MODEL||'gemini-3.5-flash-lite',baseUrl=process.env.GEMINI_API_BASE_URL||'https://generativelanguage.googleapis.com/v1beta',enableSearch=String(process.env.GEMINI_PRODUCT_ENABLE_GOOGLE_SEARCH??'true').toLowerCase()==='true',timeoutMs=Number(process.env.GEMINI_PRODUCT_TIMEOUT_MS||14000),maxRetries=Number(process.env.GEMINI_PRODUCT_MAX_RETRIES||0),fetchImpl=globalThis.fetch}={}){
    super('Gemini Product Intelligence');
    this.apiKey=String(apiKey||'').trim();this.model=String(model||'gemini-3.5-flash-lite').trim();this.baseUrl=String(baseUrl).replace(/\/$/,'');this.enableSearch=enableSearch;this.timeoutMs=Math.max(7000,Math.min(20000,timeoutMs));this.maxRetries=Math.max(0,Math.min(1,Number(maxRetries)||0));this.fetchImpl=fetchImpl;
    this.fastGeneration=String(process.env.PRODUCT_GENERATION_FAST_MODE||'true').toLowerCase()!=='false';this.thinkingLevel=String(process.env.GEMINI_PRODUCT_THINKING_LEVEL||process.env.GEMINI_THINKING_LEVEL||'low').toLowerCase();
    this._runtimeStatus=this.isConfigured()?'CHECKING':'NOT CONFIGURED';this._lastError='';this._lastCheckedAt='';
  }
  _modelCandidates(){
    const configured=String(process.env.GEMINI_PRODUCT_FALLBACK_MODELS||'gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(x=>x.trim()).filter(Boolean);
    // Keep a short current-model fallback chain. Authentication/rate/timeout errors
    // never cascade; only model/compatibility errors move to the next candidate.
    return [...new Set([this.model,...configured,'gemini-3.8-flash','gemini-3.6-flash','gemini-3.5-flash','gemini-3.5-flash-lite'].filter(Boolean))].slice(0,4);
  }
  isConfigured(){return Boolean(hasUsableApiKey(this.apiKey)&&this.fetchImpl);}
  status(){return {name:this.name,configured:this.isConfigured(),status:this._runtimeStatus,active:this._runtimeStatus==='ACTIVE',safe_reason:this._lastError||'',last_checked_at:this._lastCheckedAt||'',model:this.model,search_grounding:this.enableSearch,product_intelligence_version:PRODUCT_INTELLIGENCE_VERSION};}
  _setRuntimeStatus(status,error=''){this._runtimeStatus=status;this._lastError=String(error||'');this._lastCheckedAt=new Date().toISOString();}
  async checkConnection(){
    if(!this.isConfigured()){this._setRuntimeStatus('NOT CONFIGURED','');return this.status();}
    this._setRuntimeStatus('CHECKING','');
    let lastError=null;
    for(const model of this._modelCandidates()){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(12000,this.timeoutMs));
      try{
        const url=`${this.baseUrl}/models/${encodeURIComponent(model)}`;
        const res=await this.fetchImpl(url,{method:'GET',headers:{accept:'application/json','x-goog-api-key':this.apiKey},signal:controller.signal});
        const responseText=await res.text();
        if(!res.ok){let apiMessage='';try{const parsed=JSON.parse(responseText);apiMessage=String(parsed?.error?.message||parsed?.message||'');}catch{}const e=new Error(`Gemini configuration check failed (${res.status})`);e.status=res.status;e.apiMessage=apiMessage;e.code=/api[_ ]?key.*(?:invalid|not valid)|API_KEY_INVALID/i.test(apiMessage)?'AUTHENTICATION_FAILED':(res.status===404?'MODEL_NOT_FOUND':'API_REQUEST_FAILED');throw e;}
        this.model=model;this._setRuntimeStatus('ACTIVE','');return this.status();
      }catch(e){lastError=e;if(Number(e?.status||0)!==404&&Number(e?.status||0)!==400)break;}
      finally{clearTimeout(timer);}
    }
    const code=errorCode(lastError||new Error('Gemini configuration check failed'));this._setRuntimeStatus(code,safeErrorMessage(code,Number(lastError?.status||0)));return this.status();
  }
  _prompt(input={},repairContext=null){
    const suggested=schemaForCategory(input.category,input.product_name);
    const evidence=compactEvidenceForPrompt(input);
    const repair=repairContext?`\nREPAIR REQUIRED\nThe previous complete-object response was invalid or incomplete. Missing/invalid section(s): ${repairContext.missing.join(', ')}.\nPrevious response: ${JSON.stringify(repairContext.previous).slice(0,9000)}\nReturn the COMPLETE corrected object again. Do not return only the missing section.\n`:'';
    return `You are a professional technical product research specialist for industrial, laboratory, scientific, electrical, instrumentation, measurement, medical and testing products.

The PRODUCT NAME from the CRM lead is the source of truth.
Requested product: ${input.product_name||''}
Brand if known: ${input.brand||''}
Model if known: ${input.model||''}
Detected category: ${input.category||''}
Customer enquiry/context: ${input.customer_enquiry||input.requirement||''}
Base product parsed from the enquiry: ${input.base_product_name||input.request_analysis?.base_product||''}
Requested modifier/capabilities: ${JSON.stringify(input.requested_capabilities||input.request_analysis?.requested_capabilities||[])}
Deterministic request interpretation: ${JSON.stringify(input.request_analysis||{})}
Research evidence: ${JSON.stringify(evidence)}
Research provider trace: ${JSON.stringify(input.provider_trace||[])}
Category field hints (hints only): ${suggested.join(', ')}

First identify what this product actually is. Then create ONE COMPLETE product information record containing ALL FOUR mandatory sections together:
1. technically relevant Specifications
2. one professional Product Description
3. meaningful Key Features
4. practical Applications

RULES
- Product names may contain BOTH a base product and a customer-required capability/variant. Preserve both. Example: "Digital Manometer with Flow" means a DIGITAL MANOMETER is the base product and FLOW/AIRFLOW capability is a mandatory requested feature; do not reduce it to a generic manometer.
- Build request_analysis first. Explain the base product, requested modifier/capabilities, what the customer likely means, the selection points that matter, 3-7 concise questions still required before quotation, and a practical sales pitch.
- If the customer already stated a capability in the product name or enquiry, do NOT ask whether they need that capability. Ask only for missing technical details such as range, accuracy, probe/Pitot compatibility, units, logging/interface, duct/area input, accessories, quantity or delivery.
- Specifications must change according to the actual product category. Never use one fixed specification template.
- If exact brand/model data is available, use model-specific technical information where reliable.
- If exact brand/model data is unavailable, provide a safe category-specific profile without inventing precise numeric values.
- Never combine specifications from different models. Requested model is: ${input.model||'(not supplied)'}.
- Prefer evidence in this order: internal manually verified company record; official manufacturer; official datasheet/manual/catalogue; authorized distributor; multiple consistent technical sources; IndiaMART exact-model listing; IndiaMART generic category listings; other reliable public sources; general product knowledge.
- For identity naming, search IndiaMART and manufacturer naming. Return a clean professional product name that keeps the requested product meaning, brand and exact model. Do not replace it with a different model or broader category.
- Never invent precise numeric ranges, accuracy, voltage, capacity, certifications, dimensions or model-specific functions when they are not supported. Omit unsupported precise rows.
- Do not use supplier contacts, seller phone/email/address/GST/price as technical specifications.
- Do not write salesperson/CRM guidance such as "confirm measuring range", "match customer requirement", "application to be confirmed", "working guidance", "verify before quotation", "product details need verification" or "model dependent".
- Product Description is mandatory. Write a useful professional paragraph explaining what the product is, what it does, important supported capabilities, and typical professional use. Aim for about 55-100 words. Keep it concise so the CRM can display the result quickly.
- Key Features are mandatory. Prefer 5-8 actual product capabilities; never salesperson instructions.
- Applications are mandatory. Prefer 4-7 real product use cases where appropriate.
- All four sections must be present in this SAME response.

Return structured JSON only with this shape:
{
  "identity":{"product_name":"","brand":"","model":"","category":"","identity_confidence":0},
  "request_analysis":{"original_request":"","base_product":"","requested_modifier":"","requested_capabilities":[""],"interpreted_need":"","selection_focus":[""],"questions_to_confirm":[""],"sales_pitch":""},
  "specifications":[{"name":"","value":"","confidence":0,"source_type":"internal|manufacturer|indiamart|other","source":"","source_url":"","verification_status":"VERIFIED|MULTIPLE SOURCES AGREE|AI NORMALIZED|NEEDS VERIFICATION"}],
  "description":"",
  "key_features":[""],
  "applications":[""],
  "sources":[{"type":"manufacturer|indiamart|internal|other","title":"","url":""}]
}
${repair}`;
  }
  async _request(input,{search=true,useSchema=true,repairContext=null,model=this.model}={}){
    if(!this.isConfigured()){const e=new Error('Gemini key missing');e.code='KEY_MISSING';throw e;}
    const url=`${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const generationConfig={responseMimeType:'application/json',maxOutputTokens:3200,temperature:0.15};
    if(/^gemini-3(?:\.|-|$)/i.test(String(model||''))&&['low','medium','high','minimal'].includes(this.thinkingLevel))generationConfig.thinkingConfig={thinkingLevel:this.thinkingLevel};
    if(useSchema)generationConfig.responseSchema=RESPONSE_SCHEMA;
    const body={contents:[{role:'user',parts:[{text:this._prompt(input,repairContext)}]}],generationConfig};
    if(search&&this.enableSearch)body.tools=[{google_search:{}}];
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try{
      const res=await this.fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':this.apiKey},body:JSON.stringify(body),signal:controller.signal});
      const text=await res.text();
      if(!res.ok){let apiMessage='';try{const parsed=JSON.parse(text);apiMessage=String(parsed?.error?.message||parsed?.message||'');}catch{}const e=new Error(`Gemini request failed (${res.status})`);e.status=res.status;e.apiMessage=apiMessage;e.code=/api[_ ]?key.*(?:invalid|not valid)|API_KEY_INVALID/i.test(apiMessage)?'AUTHENTICATION_FAILED':(res.status===404?'MODEL_NOT_FOUND':'API_REQUEST_FAILED');throw e;}
      try{return JSON.parse(text);}catch{const e=new Error('Gemini outer response was invalid JSON');e.code='INVALID_RESPONSE';throw e;}
    }finally{clearTimeout(timer);}
  }
  _normalize(body,input={},usedSearch=false){
    let raw;
    try{raw=extractJson(textFromResponse(body));}catch{const e=new Error('Gemini product-information JSON could not be parsed');e.code='INVALID_RESPONSE';throw e;}
    const identity=raw.identity||{};
    identity.product_name=String(identity.product_name||input.product_name||'').trim();
    identity.brand=String(identity.brand||detectBrand(identity.product_name,input.brand)||'').trim();
    identity.model=String(identity.model||detectModel(identity.product_name,input.model)||'').trim();
    identity.category=String(identity.category||detectCategory(`${identity.product_name} ${identity.model}`)||'').trim();
    identity.confidence=identityConfidence(input,{...identity,confidence:normalizeConfidence(identity.identity_confidence||identity.confidence||0)});
    identity.identity_confidence=identity.confidence;
    const deterministic=input.request_analysis||{};const generated=raw.request_analysis||{};
    const request_analysis={
      original_request:cleanText(generated.original_request||deterministic.original_request||input.product_name||''),
      base_product:cleanText(generated.base_product||deterministic.base_product||input.base_product_name||input.product_name||''),
      requested_modifier:cleanText(generated.requested_modifier||deterministic.requested_modifier||''),
      requested_capabilities:cleanList((generated.requested_capabilities?.length?generated.requested_capabilities:deterministic.requested_capabilities)||[],10),
      interpreted_need:cleanDescription(generated.interpreted_need||deterministic.interpreted_need||''),
      selection_focus:cleanList((generated.selection_focus?.length?generated.selection_focus:deterministic.selection_focus)||[],12),
      questions_to_confirm:cleanList(generated.questions_to_confirm||[],10),
      sales_pitch:cleanDescription(generated.sales_pitch||'')
    };
    const ground=groundingSources(body),declared=uniqueSources(raw.sources||[]),researchSources=uniqueSources(input.research_sources||[]),sources=uniqueSources([...researchSources,...ground,...declared]);
    const trustedUrls=new Set(sources.map(x=>x.url).filter(Boolean)),evidencePairs=evidencePairsForInput(input);
    const specs=(Array.isArray(raw.specifications)?raw.specifications:[]).map(x=>normalizeSpec(x,trustedUrls,evidencePairs)).filter(Boolean);
    const sourceByUrl=new Map(sources.map(s=>[s.url,s]));
    for(const s of specs){if(s.source_url&&!sourceByUrl.has(s.source_url)){const extra={type:'Declared Source',name:s.source||'Source',url:s.source_url};sources.push(extra);sourceByUrl.set(extra.url,extra);}}
    return {status:'OK',provider:this.name,used_search:Boolean(usedSearch&&ground.length),content_format_version:'3.0.0',product_intelligence_version:PRODUCT_INTELLIGENCE_VERSION,generation_status:'COMPLETE',model_used:this.model,identity,request_analysis,specifications:specs,description:cleanDescription(raw.description),features:cleanList(raw.key_features?.length?raw.key_features:raw.features,12),applications:cleanList(raw.applications,16),sources};
  }
  async _requestWithCompatibilityFallback(input){
    const models=this._modelCandidates();
    let lastErr=null;
    for(let i=0;i<models.length;i++){
      const model=models[i];
      try{
        const body=await this._request(input,{search:this.enableSearch,useSchema:true,model});
        this.model=model;
        return {body,usedSearch:this.enableSearch};
      }catch(e){
        lastErr=e;const status=Number(e?.status||0),code=errorCode(e);
        if(['AUTHENTICATION_FAILED','RATE_LIMITED','TIMEOUT'].includes(code))throw e;
        // Some model/tool combinations can reject schema + Google Search. Retry the
        // same model once without grounding before trying another model.
        if(this.enableSearch&&status===400){
          try{const body=await this._request(input,{search:false,useSchema:true,model});this.model=model;return {body,usedSearch:false};}
          catch(inner){lastErr=inner;const innerCode=errorCode(inner);if(['AUTHENTICATION_FAILED','RATE_LIMITED','TIMEOUT'].includes(innerCode))throw inner;if(![400,404].includes(Number(inner?.status||0)))throw inner;}
        } else if(![400,404].includes(status)) throw e;
      }
    }
    throw lastErr||new Error('Gemini product intelligence failed');
  }
  async _analyzeNow(input={},options={}){
    if(!this.isConfigured()){this._setRuntimeStatus('NOT CONFIGURED','');return {status:'KEY_MISSING',error_code:'KEY_MISSING',error:safeErrorMessage('KEY_MISSING')};}
    try{
      const first=await this._requestWithCompatibilityFallback(input);
      let normalized=this._normalize(first.body,input,first.usedSearch);
      let validation=validateCompleteProductInformation(normalized);
      if(!validation.ok&&!this.fastGeneration){
        const repairBody=await this._request(input,{search:false,useSchema:true,model:this.model,repairContext:{missing:validation.missing,previous:{identity:normalized.identity,request_analysis:normalized.request_analysis,specifications:normalized.specifications,description:normalized.description,key_features:normalized.features,applications:normalized.applications,sources:normalized.sources}}});
        normalized=this._normalize(repairBody,input,false);
        validation=validateCompleteProductInformation(normalized);
      }
      if(!validation.ok){this._setRuntimeStatus('INVALID_RESPONSE',safeErrorMessage('INVALID_RESPONSE'));return {status:'INVALID_RESPONSE',error_code:'INVALID_RESPONSE',error:safeErrorMessage('INVALID_RESPONSE'),validation};}
      this._setRuntimeStatus('ACTIVE','');
      return {...normalized,validation};
    }catch(e){
      const code=e?.code==='KEY_MISSING'?'KEY_MISSING':errorCode(e),msg=safeErrorMessage(code,Number(e?.status||0));
      this._setRuntimeStatus(code==='KEY_MISSING'?'NOT CONFIGURED':code,msg);
      return {status:code,error_code:code,error:msg,http_status:Number(e?.status||0)||null};
    }
  }
  analyze(input={},options={}){
    return this._analyzeNow(input,options);
  }
}
