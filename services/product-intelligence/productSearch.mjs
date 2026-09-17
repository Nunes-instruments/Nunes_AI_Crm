import { detectBrand, detectCategory, detectModel, interpretProductRequest, normalizeProductName, productCacheKey } from './productNormalizer.mjs';

export function buildProductIntelligenceInput(requirement={}) {
  const product_name=String(requirement.product_name||'').trim();
  const customer_enquiry=[requirement.other_notes,requirement.application,requirement.required_specification,requirement.required_range,requirement.required_accuracy,requirement.requested_features,requirement.requested_accessories,requirement.requested_certification].filter(Boolean).join(' | ');
  const request_analysis=interpretProductRequest(product_name,customer_enquiry);
  const brand=detectBrand(product_name,requirement.requested_brand||requirement.preferred_brand||'');
  const model=detectModel(product_name,requirement.requested_model||'');
  const category=detectCategory(`${product_name} ${request_analysis.category||''} ${brand} ${model}`);
  const request_signature=[request_analysis.requested_modifier,...(request_analysis.requested_capabilities||[])].filter(Boolean).join(' | ');
  return {
    product_name,
    original_product_name:product_name,
    base_product_name:request_analysis.base_product||product_name,
    normalized_product_name:normalizeProductName(product_name),
    brand, model, category,
    request_analysis,
    requested_capabilities:request_analysis.requested_capabilities||[],
    selection_focus:request_analysis.selection_focus||[],
    customer_enquiry,
    requirement:[requirement.application,requirement.required_specification,requirement.required_range,requirement.required_accuracy,requirement.requested_features,request_signature].filter(Boolean).join(' | '),
    cache_key:productCacheKey({product_name,brand,model,request_signature})
  };
}
