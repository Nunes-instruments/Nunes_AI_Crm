export { ProductIntelligenceProvider } from './ProductIntelligenceProvider.mjs';
export { GeminiProductIntelligenceProvider } from './GeminiProductIntelligenceProvider.mjs';
export { buildProductIntelligenceInput } from './productSearch.mjs';
export { normalizeProductName, compactModel, detectBrand, detectModel, detectCategory, productCacheKey } from './productNormalizer.mjs';
export { schemaForCategory } from './productSchemas.mjs';
export { identityConfidence, looksPreciseTechnicalValue } from './productConfidence.mjs';

export { ProductResearchOrchestrator } from './ProductResearchOrchestrator.mjs';
export { GeminiProductSynthesisProvider } from './GeminiProductSynthesisProvider.mjs';
export { InternalProductProvider, DriveProductProvider, ManufacturerSearchProvider, IndiaMartProductResearchProvider, PublicWebProductProvider, buildProductSearchVariants, scoreProductIdentity } from './researchProviders.mjs';
