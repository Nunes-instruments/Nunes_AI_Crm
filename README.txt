NUNES AI CRM V2.7.1

FASTEST NORMAL USE
1. Extract the ZIP fully to a normal folder.
2. Double-click NUNES_AI_CRM.bat or START_CRM.bat.
3. On a new Windows PC, the small setup step runs automatically only if the shared portable runtime is not already available.

OPTIONAL FIRST SETUP
- INSTALL_CRM.bat prepares the runtime, initializes the CRM connection files, creates a Desktop shortcut when possible, and starts the CRM.
- There is NO npm install and NO developer-tool installation.
- The portable runtime is cached in Local AppData and reused by later NUNES AI CRM versions.

OTHER DEVICES
- The browser UI adapts to Windows desktops/laptops and to tablet/phone screen sizes.
- Run SETUP_FIREWALL.bat once as Administrator if another device on the office network must connect.
- Run SHOW_OTHER_DEVICE_LINKS.bat to display available office-network/Tailscale URLs.

V2.6.7 SALES FUNCTIONS RETAINED
- AI Questions to Ask Customer (missing-information only)
- Why This Product Fits This Customer + Suggested Sales Pitch
- AI Solution Recommendation
- AI-assisted Limited-Time Offer with safe-margin protection and Draft/Sent/Active/final states
- AI Objection Assistant with Copy / WhatsApp / Mail
- Close This Sale with Ask for Order / Send PI / Confirm Order / Payment Follow-Up
- Ultra-fast saved-product/Gemini product intelligence
- Online price research and INDIA / EXPORT margin logic
- Company CRM LIVE connection
- WhatsApp Web and Gmail messaging
- Quotations, follow-ups, customer history and existing one-page lead form

V2.6.8 changes only Windows/device compatibility and setup speed. Existing business logic is not intentionally changed.


V2.6.9 TEAM SETUP
- Owner: use the normal NUNES AI CRM desktop shortcut.
- Staff PC: run CREATE_STAFF_DESKTOP_SHORTCUT.bat and select one of the 10 staff profiles.
- Staff photos/names can be edited in Admin Settings > Sales Team.
- Data remains in data\nunes-crm.sqlite and automatic safety backups are stored in backups\automatic.


V2.7.0 FINAL BUTTON RELIABILITY
- All visible action buttons stay enabled in normal use.
- Missing WhatsApp, Gmail, phone, email or online-price prerequisites are explained when the button is clicked instead of leaving the button greyed out.
- Pagination and Back controls safely explain when there is nowhere else to go.
- Temporary busy protection is kept only while a save/send request is actively running, then the button automatically re-enables.
- Non-working report View All controls were replaced with working navigation links.
- Existing data, owner/staff dashboards, Gemini, CRM, pricing, backups and all-device setup are unchanged.

V2.7.2 DASHBOARD UPDATE
- Dashboard uses real CRM staff names/photos; unused Staff 01..10 placeholders are hidden automatically.
- Day / Week / Month animated performance race added.
- Completed / Waiting / Pending / Not Purchased / Orders are visible by staff and overall.
- Click any staff member for the full report.


V2.7.3 Dashboard update:
- Today, Week and Month staff races are all visible together on Dashboard.
- Race rows use the staff names/photos stored in CRM; LeadSphere owner photo/image fields are synchronized when provided by the connected CRM.
- Completed, waiting, pending, not-purchased and order counts remain visible in the race.


V2.7.5 STAFF PHOTO ATTACHMENT
- Uses the portraits supplied in staff.docx; no generated/replacement faces are used.
- Photos are matched to the existing CRM staff name (case/spacing-insensitive).
- Dashboard Today / Week / Month races, staff cards, staff detail pages and sidebar use the same attached portrait.
- Photos are served locally for fast loading and work even when the external CRM image URL is protected/offline.
- Existing staff names, lead ownership, CRM data and all V2.7.4 functions are unchanged.


V2.7.8 LIMITED-TIME OFFER CALCULATION REPAIR
- Regular Selling Price immediately calculates the safe 4% suggested offer.
- Safe maximum discount, offer price and resulting margin update live.
- India uses 40% and Export uses 60% as the regular-margin reference when cost is unavailable.
- The server always protects the minimum 30% margin.

V2.7.7 LIMITED-TIME OFFER + FRONTEND TEXT FIX
- Removed the requested repeated Dashboard and My Leads guidance text.
- Limited-Time Offer accepts either Online Price or Regular Selling Price.
- Manual entry, safe-margin protection, sending, countdown and status are preserved.

V2.7.6 PRICE / LIMITED-OFFER INPUT BUG FIX
- Price and limited-offer numeric fields are editable.
- Manual Online Price persists when online research cannot find an exact price.
- Safe Margin Protection remains server-enforced.

V2.9.0 LOCAL SERVER + 10 STAFF DESKTOP APP
- Fixes SQLite "disk I/O error" when the CRM source folder is on a NAS/SMB share.
- INSTALL_CRM.bat installs the live MAIN server to %LOCALAPPDATA%\NunesAI\CRMServer\App and preserves existing local data/.env during upgrades.
- The MAIN server starts automatically at Windows sign-in and the owner gets a NUNES AI CRM desktop app shortcut.
- Each staff PC runs SETUP_STAFF_PC.bat once, chooses its CRM staff profile, and receives a named desktop app shortcut.
- Staff PCs are clients only: no SQLite, no Node.js and no second CRM server.
- Keep one MAIN server/database for all 10 staff.

V2.9.1 WINDOWS DESKTOP LAUNCHER PATH FIX
- Fixes PowerShell "Test-Path : Illegal characters in path" on the main server desktop app.
- Desktop launcher derives its local path internally instead of passing a trailing-backslash folder argument.
- Existing local CRM data is preserved during the upgrade.
