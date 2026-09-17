# Integration provider layer

The CRM runtime includes a configurable, read-only company CRM lead importer. LeadSphere defaults are built in and initialized automatically on `START_CRM.bat`. Run `CONFIGURE_COMPANY_CRM.bat` only when changing the provider URL, endpoint, authentication settings, sync settings, or API key. The active key is encrypted for the current Windows user and never exposed to the browser.

The generic importer supports common JSON list containers (`data.leads`, `data.items`, `leads`, `items`, `records`, and `results`) and common customer/lead field names. Provider-specific APIs may need a small field mapping adjustment after the exact CRM documentation is supplied.
