import { compactModel, normalizeProductName } from './productNormalizer.mjs';

function capabilityAdjustment(requested={},resolved={}){
  const caps=(requested.requested_capabilities||requested.request_analysis?.requested_capabilities||[]).map(x=>normalizeProductName(x)).filter(Boolean);
  if(!caps.length)return 0;
  const hay=normalizeProductName(`${resolved.product_name||resolved.name||''} ${resolved.category||''} ${resolved.product_type||''}`);
  let misses=0;
  for(const cap of caps){
    const words=cap.split(' ').filter(x=>x.length>2&&!['MEASUREMENT','REQUIREMENT','CONFIGURATION','INTERFACE'].includes(x));
    if(words.length&&!words.some(w=>hay.includes(w)))misses++;
  }
  return misses===0?4:(misses===caps.length?-22:-10);
}

export function identityConfidence(requested={}, resolved={}) {
  const reqModel = compactModel(requested.model || requested.requested_model || '');
  const gotModel = compactModel(resolved.model || '');
  const reqBrand = normalizeProductName(requested.brand || requested.requested_brand || '');
  const gotBrand = normalizeProductName(resolved.brand || '');
  const reqName = normalizeProductName(requested.product_name || '');
  const gotName = normalizeProductName(resolved.product_name || resolved.name || '');
  let score=45;
  if (reqModel && gotModel && reqModel === gotModel && reqBrand && gotBrand && reqBrand === gotBrand) score=98;
  else if (reqModel && gotModel && reqModel === gotModel) score=94;
  else if (reqModel && gotModel && (reqModel.includes(gotModel) || gotModel.includes(reqModel)) && reqName && gotName && (reqName.includes(gotName) || gotName.includes(reqName))) score=90;
  else if (reqBrand && gotBrand && reqBrand === gotBrand && reqModel && gotModel && (reqModel.includes(gotModel) || gotModel.includes(reqModel))) score=75;
  else if (reqName && gotName && reqName === gotName) score=88;
  else if (reqName && gotName && (reqName.includes(gotName) || gotName.includes(reqName))) score=72;
  return Math.max(0,Math.min(99,score+capabilityAdjustment(requested,resolved)));
}

export function looksPreciseTechnicalValue(value='') {
  const v = String(value || '').trim();
  if (!v) return false;
  return /\d/.test(v) && /(%|°|hz|khz|mhz|ghz|v\b|a\b|ma\b|mv\b|lux|fc\b|mm\b|cm\b|kg\b|g\b|mg\b|ppm|ppb|nm\b|um\b|µm|ml\b|l\b|w\b|kw\b|s\b|ms\b|bit|count|range|±|\+\/-)/i.test(v);
}
