# NUNES AI CRM

Current production version: **2.11.2**.

## Production update flow

`main` is the source of truth. The main Windows CRM server checks `VERSION.txt` on GitHub every 5 minutes. When a newer version is available it downloads the repository branch, validates required files, creates a SQLite pre-update backup, preserves all live data/settings, installs changed program files, and restarts the server. Owner and Staff browser apps then reload automatically; their desktop launchers self-update from the main server.

**Never commit production data or credentials.** `.env`, SQLite databases, OAuth tokens, device tokens, LeadSphere credentials, runtime data, backups and staff photos are excluded by `.gitignore`.

For the first V2.11.2 migration only, run `UPDATE_REPAIR_SERVER.bat` on the main server. After that, normal updates are GitHub-driven.

If the GitHub repository is still empty, run **GITHUB_PUBLISH_MASTER.bat**. It provides an automatic Git push option and a safe manual-browser upload folder option. The automatic push option also force-syncs/restarts the installed main server from GitHub immediately, so Owner and Staff receive the server version without waiting for the 5-minute poll. It never intentionally publishes the live SQLite database, `.env`, OAuth/device tokens, backups, logs, runtime files, or staff photos.

---

## One-click Windows use

Extract the ZIP, then double-click **NUNES_AI_CRM.bat** or **START_CRM.bat**. There is no npm install. If the PC has no compatible runtime yet, the launcher prepares one portable runtime once and reuses it for later CRM versions.

`INSTALL_CRM.bat` is optional. It prepares the runtime, initializes the Windows-user CRM connection data, creates a desktop shortcut when possible, and starts the CRM.

## Windows / device compatibility

The runtime bootstrap automatically handles Windows x64, x86/32-bit, and ARM64 packages. The existing responsive web UI is retained and strengthened for touch and narrow screens without changing the desktop layout.

For phones, tablets, or another office PC, run `SETUP_FIREWALL.bat` once as Administrator, start the CRM, then run `SHOW_OTHER_DEVICE_LINKS.bat` to see LAN/Tailscale browser addresses.

## Existing CRM features

V2.6.7 Gemini, product library, online price, INDIA/EXPORT pricing, Company CRM LIVE, WhatsApp/Gmail, quotations, limited-time offers, AI questions, customer-specific value, recommendations, objection assistant, and closing actions remain in place.


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


V2.7.3 Dashboard update:
- Today, Week and Month staff races are all visible together on Dashboard.
- Race rows use the staff names/photos stored in CRM; LeadSphere owner photo/image fields are synchronized when provided by the connected CRM.
- Completed, waiting, pending, not-purchased and order counts remain visible in the race.


## V2.7.5 - Staff portraits from supplied staff.docx

The 10 supplied staff portraits are bundled locally and matched to the existing CRM staff names. The CRM does not rename staff accounts. The same local portrait is used in the Dashboard Today/Week/Month races, staff cards, staff details and profile surfaces, with initials only for unmatched names.


## V2.7.8 - Limited-Time Offer calculation repair

- Entering Regular Selling Price immediately calculates the 4% suggested offer when safely possible.
- Safe maximum discount, suggested offer, and margin update live.
- India uses a 40% regular-margin reference when no cost price exists; Export uses 60%.
- The server still blocks any offer below the 30% minimum margin.

## V2.7.7 - Limited-Time Offer + frontend text fix

- Removed the requested repeated Dashboard and My Leads guidance text.
- Limited-Time Offer accepts either Online Price or Regular Selling Price.
- Manual offer entry, safe-margin protection, WhatsApp/Mail sending, countdown and status flow remain available.

## V2.7.6 - Price / Limited-Time Offer input bug fix

Price and limited-offer number fields are now editable. Manual base prices persist, margin editing is direct, and offer validity/discount/regular price/offer price can be typed normally. Safe Margin Protection is still enforced by the server, so an unsafe offer is automatically clamped to the approved minimum margin.

## V2.9.0 - Local server + 10 staff desktop apps

This release prevents the SQLite `disk I/O error` caused by running the live WAL database from an SMB/NAS path. `INSTALL_CRM.bat` installs the main server on the local Windows disk under `%LOCALAPPDATA%\NunesAI\CRMServer\App`, preserves the existing local database/configuration on upgrades, creates the owner desktop app shortcut, and adds background startup at Windows sign-in.

Run `SETUP_STAFF_PC.bat` once on each staff computer. It connects to the one main server, lets you choose the staff profile, and creates `NUNES AI CRM - <Staff Name>` on that desktop. Staff computers do not run SQLite or Node.js and must not start a second CRM server.

## V2.9.1 - Windows desktop launcher path repair
- Fixes `Test-Path : Illegal characters in path` when opening the locally installed main CRM app.
- The PowerShell launcher now derives the CRM root from its own script location and defensively normalizes legacy path values.
- Existing one-main-server / ten-staff-desktop-client architecture remains unchanged.


## V2.9.5 - Personal staff WhatsApp and Gmail

Shared company messaging has been removed. Every staff computer/browser uses that staff member's own WhatsApp Web and Gmail login. Sign in once from the device-profile menu; customer message buttons then open the prepared message in that same personal browser session. Team Reports, live Today/Week/Month race, staff assignment rules, and the one central CRM database remain shared and unchanged.