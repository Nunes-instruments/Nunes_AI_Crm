/**
 * Provider contracts for integrations.
 * The standalone runtime uses local verified data, and business code should target
 * these capabilities when Google Drive, Gmail, WhatsApp, IndiaMART, AI APIs,
 * quotation services, or the company CRM are connected.
 */
export class LeadSourceProvider {
  async fetchLeads() { throw new Error('Not implemented'); }
  async acknowledgeLead(_externalId) { throw new Error('Not implemented'); }
}
export class AIProvider {
  async parseEnquiry(_text) { throw new Error('Not implemented'); }
  async generateProductIntelligence(_requirement) { throw new Error('Not implemented'); }
  async recommendNextAction(_leadContext) { throw new Error('Not implemented'); }
}
export class ProductSearchProvider {
  async search(_query) { throw new Error('Not implemented'); }
}
export class PriceProvider {
  async findPrice(_product) { throw new Error('Not implemented'); }
  async verifyPrice(_priceId) { throw new Error('Not implemented'); }
}
export class StorageProvider {
  async searchDocuments(_query) { throw new Error('Not implemented'); }
  async saveAttachment(_file) { throw new Error('Not implemented'); }
}
export class EmailProvider {
  async createDraft(_message) { throw new Error('Not implemented'); }
  async send(_message) { throw new Error('Not implemented'); }
}
export class WhatsAppProvider {
  async createMessage(_message) { throw new Error('Not implemented'); }
  async send(_message) { throw new Error('Not implemented'); }
}
export class CRMProvider {
  async upsertLead(_lead) { throw new Error('Not implemented'); }
  async syncCustomer(_customer) { throw new Error('Not implemented'); }
}
export class QuotationProvider {
  async createQuotation(_lead) { throw new Error('Not implemented'); }
}
