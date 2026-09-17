import fs from 'node:fs';
import path from 'node:path';

export function normalizeProductText(value='') {
  return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}

function compactModel(value='') { return normalizeProductText(value).replace(/\s+/g,''); }
function tokenScore(query, corpus) {
  const q=[...new Set(normalizeProductText(query).split(' ').filter(Boolean))];
  if(!q.length) return 0;
  const c=normalizeProductText(corpus);
  const hits=q.filter(t=>c.includes(t)).length;
  return Math.round((hits/q.length)*35);
}

export class ProductSearchProvider {
  constructor(name){ this.name=name; }
  search(){ return []; }
}

export class DatabaseProductProvider extends ProductSearchProvider {
  constructor(db){ super('Internal Product Database'); this.db=db; }
  search(requirement={}) {
    const rows=this.db.prepare(`SELECT p.*, GROUP_CONCAT(a.alias,'|') AS aliases FROM products p LEFT JOIN product_aliases a ON a.product_id=p.id GROUP BY p.id`).all();
    const query=[requirement.product_name,requirement.requested_brand,requirement.requested_model,requirement.required_specification].filter(Boolean).join(' ');
    return rows.map(p=>{
      let confidence=tokenScore(query,[p.name,p.brand,p.series,p.model,p.category,p.aliases].filter(Boolean).join(' '));
      const rm=compactModel(requirement.requested_model), pm=compactModel(p.model);
      if(rm&&pm&&rm===pm) confidence+=55;
      else if(rm&&pm&&(pm.includes(rm)||rm.includes(pm))) confidence+=38;
      if(requirement.requested_brand&&p.brand&&normalizeProductText(requirement.requested_brand)===normalizeProductText(p.brand)) confidence+=12;
      const qn=normalizeProductText(requirement.product_name), pn=normalizeProductText(p.name);
      if(qn&&pn&&(qn===pn)) confidence+=35;
      else if(qn&&pn&&(pn.includes(qn)||qn.includes(pn))) confidence+=20;
      confidence=Math.max(0,Math.min(99,confidence));
      return {provider:this.name,product:p,confidence,source:'Internal Product Database',verification_status:'CONFIRMED'};
    }).filter(x=>x.confidence>=25).sort((a,b)=>b.confidence-a.confidence).slice(0,12);
  }
}

function parseCsv(text='') {
  const rows=[]; let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){
      if(quoted&&text[i+1]==='"'){cell+='"';i++;} else quoted=!quoted;
    } else if(ch===','&&!quoted){row.push(cell);cell='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>String(x).trim()))rows.push(row);row=[];cell='';}
    else cell+=ch;
  }
  if(cell||row.length){row.push(cell);if(row.some(x=>String(x).trim()))rows.push(row);}
  if(rows.length<2)return [];
  const headers=rows[0].map(h=>normalizeProductText(h).replace(/ /g,'_'));
  return rows.slice(1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,String(r[i]??'').trim()])));
}

export class FileProductProvider extends ProductSearchProvider {
  constructor(dataDir){ super('Company Product Master File'); this.dataDir=dataDir; this.cache={mtime:0,rows:[],records:[],file:null,byModel:new Map(),byCode:new Map(),byBrandModel:new Map(),byName:new Map(),byToken:new Map()}; }
  _productFromRow(r={}){return {
    id:null,name:r.product_name||r.name||r.product||r.item_name||r.item||r.material_name||'',brand:r.brand||r.make||r.manufacturer||'',series:r.series||'',model:r.model||r.model_no||r.model_number||r.model_name_number||'',category:r.category||r.product_category||'',
    description:r.description||'',internal_code:r.product_code||r.internal_code||r.product_id||r.code||'',image_path:r.image_path||r.image||'',key_features_json:r.key_features||r.features||'',applications_json:r.applications||''
  };}
  _push(map,key,index){if(!key)return;const arr=map.get(key);if(arr)arr.push(index);else map.set(key,[index]);}
  _load(){
    const candidates=['product-master.json','product-master.csv'];let file=null;for(const n of candidates){const p=path.join(this.dataDir,n);if(fs.existsSync(p)){file=p;break;}}
    if(!file)return this.cache;
    const mtime=fs.statSync(file).mtimeMs;if(this.cache.mtime===mtime)return this.cache;
    let rows=[];try{const raw=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');rows=file.endsWith('.json')?(JSON.parse(raw)||[]):parseCsv(raw);if(!Array.isArray(rows))rows=[];}catch{rows=[];}
    const cache={mtime,rows,file,records:[],byModel:new Map(),byCode:new Map(),byBrandModel:new Map(),byName:new Map(),byToken:new Map()};
    rows.forEach((r,i)=>{const p=this._productFromRow(r),name=normalizeProductText(r.normalized_product_name||p.name),brand=normalizeProductText(r.normalized_brand||p.brand),model=compactModel(r.normalized_model||p.model),code=compactModel(r.normalized_product_code||p.internal_code),corpus=normalizeProductText([p.name,p.brand,p.model,p.category,r.aliases,r.specification].filter(Boolean).join(' '));const rec={r,p,i,name,brand,model,code,corpus};cache.records.push(rec);this._push(cache.byName,name,i);this._push(cache.byModel,model,i);this._push(cache.byCode,code,i);this._push(cache.byBrandModel,brand&&model?`${brand}|${model}`:'',i);for(const t of new Set(corpus.split(' ').filter(x=>x.length>=2)))this._push(cache.byToken,t,i);});
    this.cache=cache;return cache;
  }
  _candidateIndexes(cache,requirement={}){
    const set=new Set(),add=arr=>{for(const i of arr||[]){set.add(i);if(set.size>=3500)break;}};
    const qName=normalizeProductText(requirement.product_name),qBrand=normalizeProductText(requirement.requested_brand),qModel=compactModel(requirement.requested_model),qCode=compactModel(requirement.product_code||requirement.internal_code);
    add(cache.byModel.get(qModel));add(cache.byBrandModel.get(qBrand&&qModel?`${qBrand}|${qModel}`:''));add(cache.byCode.get(qCode));add(cache.byName.get(qName));
    for(const t of new Set([qName,qBrand,normalizeProductText(requirement.requested_model),normalizeProductText(requirement.required_specification)].join(' ').split(' ').filter(x=>x.length>=2))){add(cache.byToken.get(t));if(set.size>=3500)break;}
    return [...set];
  }
  search(requirement={}){
    const cache=this._load();if(!cache.records.length)return [];
    const query=[requirement.product_name,requirement.requested_brand,requirement.requested_model,requirement.required_specification].filter(Boolean).join(' '),indexes=this._candidateIndexes(cache,requirement);
    if(!indexes.length)return [];
    const qn=normalizeProductText(requirement.product_name),qb=normalizeProductText(requirement.requested_brand),rm=compactModel(requirement.requested_model),qCode=compactModel(requirement.product_code||requirement.internal_code);
    return indexes.map(i=>cache.records[i]).filter(Boolean).map(rec=>{const {r,p}=rec;let confidence=tokenScore(query,rec.corpus);if(rm&&rec.model&&rm===rec.model)confidence+=55;else if(rm&&rec.model&&(rec.model.includes(rm)||rm.includes(rec.model)))confidence+=38;if(qb&&rec.brand&&qb===rec.brand)confidence+=12;if(qCode&&rec.code&&qCode===rec.code)confidence+=50;if(qn&&rec.name&&qn===rec.name)confidence+=35;else if(qn&&rec.name&&(qn.includes(rec.name)||rec.name.includes(qn)))confidence+=20;return {provider:this.name,product:p,confidence:Math.min(99,confidence),source:path.basename(cache.file||'product-master'),verification_status:'NEEDS VERIFICATION',file_row:Number(r.row_number||rec.i+2),raw:r};}).filter(x=>x.product.name&&x.confidence>=25).sort((a,b)=>b.confidence-a.confidence).slice(0,20);
  }
}

export class QuotationHistoryProvider extends ProductSearchProvider {
  constructor(db){ super('Quotation History'); this.db=db; }
  search(requirement={}){
    const rows=this.db.prepare(`SELECT qi.product_name AS name,qi.model,qi.specification,MAX(q.created_at) AS last_quote_date,MAX(qi.unit_price) AS last_quote_price,COUNT(*) AS quote_count FROM quotation_items qi JOIN quotations q ON q.id=qi.quotation_id WHERE qi.product_name IS NOT NULL GROUP BY lower(qi.product_name),lower(COALESCE(qi.model,'')) ORDER BY MAX(q.created_at) DESC LIMIT 2000`).all();
    const query=[requirement.product_name,requirement.requested_model].filter(Boolean).join(' ');
    return rows.map(r=>{
      let confidence=tokenScore(query,[r.name,r.model,r.specification].filter(Boolean).join(' '));
      const rm=compactModel(requirement.requested_model),pm=compactModel(r.model);
      if(rm&&pm&&rm===pm)confidence+=50;
      const qn=normalizeProductText(requirement.product_name),pn=normalizeProductText(r.name);
      if(qn&&pn&&qn===pn)confidence+=35; else if(qn&&pn&&(qn.includes(pn)||pn.includes(qn)))confidence+=20;
      return {provider:this.name,product:{id:null,name:r.name,model:r.model||'',brand:'',series:'',category:'',description:'',internal_code:''},confidence:Math.min(95,confidence),source:'Previous quotations',verification_status:'CONFIRMED',history:r};
    }).filter(x=>x.confidence>=30).sort((a,b)=>b.confidence-a.confidence).slice(0,8);
  }
}

export function mergeProductResults(groups=[]){
  const best=new Map();
  for(const row of groups.flat()){
    const p=row.product||{};const key=[compactModel(p.model),normalizeProductText(p.brand),normalizeProductText(p.name)].join('|');
    const current=best.get(key);
    if(!current||row.confidence>current.confidence)best.set(key,row);
  }
  return [...best.values()].sort((a,b)=>b.confidence-a.confidence);
}
