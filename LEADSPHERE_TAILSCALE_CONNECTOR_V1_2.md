# LeadSphere → NUNES AI CRM v1.2

LeadSphere server address is local company configuration and is intentionally not stored in the public GitHub repository.

Lead endpoint: `/external-api/v1/leads`
Status endpoint: `/external-api/v1/status`

## Sync model
- 60-second incremental sync using `updated_after`.
- 5-minute reconciliation sync over the latest 7 received days.
- Pagination uses `next_cursor` when available, otherwise `next_offset`.
- Primary idempotency key is LeadSphere `event_id`.
- Existing records are updated when owner/status/contact/requirement/source/quotation data changes.
- Owner names are mapped automatically to local CRM users; missing names are created as local salesperson users and the mapping is stored.
- Source account / IndiaMART site, Direct/Buy and India/Export are stored separately.
- Quotation sent flag, number, sender and time are stored on the imported lead.
- Sync history stores received/new/updated/unchanged/failed/page count/response time/error.

## Setup
1. In LeadSphere: External Lead API → Generate API Key. Keep Max Connections >= 1 and daily limit 0 or high.
2. Run `CONFIGURE_COMPANY_CRM.bat`.
3. Press Enter for the default Tailscale URL and default LeadSphere endpoint.
4. Paste the LeadSphere API key.
5. Restart NUNES AI CRM.
6. Admin Settings → Test LeadSphere.

The API key stays Windows-user encrypted in `data/company-crm-key.txt`.
