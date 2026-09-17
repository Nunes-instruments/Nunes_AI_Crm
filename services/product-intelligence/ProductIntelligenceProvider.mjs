export class ProductIntelligenceProvider {
  constructor(name='Product Intelligence Provider') { this.name = name; }
  isConfigured() { return false; }
  async analyze(_input, _options={}) { throw new Error('Not implemented'); }
}
