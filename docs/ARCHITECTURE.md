# NUNES AI CRM architecture

## Runtime
- Browser UI served from `public/`
- Node.js local/LAN HTTP server in `server.mjs`
- SQLite relational database in `data/nunes-crm.sqlite`
- No Lovable runtime dependency
- No npm package installation is required by the delivered V1

## Business layers
1. Lead intake and parsing
2. Customer + independent product requirement records
3. Internal product matching
4. Dynamic product specification presentation
5. Price intelligence with verification state
6. Weighted lead qualification
7. 12-stage sales playbook
8. Next Best Action
9. Follow-up, objections and activity history
10. Quotation draft workflow
11. Customer 360, pipeline and management reporting

## Future provider boundary
See `providers/contracts.mjs` for LeadSourceProvider, AIProvider, ProductSearchProvider, PriceProvider, StorageProvider, EmailProvider, WhatsAppProvider, CRMProvider and QuotationProvider.

## Local security model
V1 is intended for a trusted private office network. Public-internet deployment must add authenticated sessions, HTTPS, CSRF protection, rate limits, hardened access controls and a managed reverse proxy/cloud deployment.
