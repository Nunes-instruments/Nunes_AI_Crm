NUNES AI CRM V2.10.0 - SAFE CENTRAL UPDATE

FIRST TIME ON THIS VERSION
--------------------------
MAIN SERVER PC:
  Run 1_SETUP_MAIN_CRM_SERVER.bat

OWNER PC:
  Run SETUP_OWNER_PC.bat once if this PC has not yet been configured with V2.10.0.

STAFF PCs:
  Run 2_SETUP_STAFF_PC.bat once if the PC has not yet been configured with V2.10.0.

NORMAL FUTURE UPDATE
--------------------
On the MAIN SERVER PC only:
  Run UPDATE_REPAIR_SERVER.bat from the new update folder.

The updater:
  1. Creates a consistent pre-update SQLite backup.
  2. Does NOT replace the installed data folder or .env.
  3. Copies only changed program files.
  4. Restarts the main server with the new version.
  5. Owner and Staff web UI gets the new server version automatically.
  6. V2.10.0+ desktop launchers check the server and self-update when opened.

STAFF WORK STATUS
-----------------
Each assigned enquiry now has:
  Active / Resume
  Put On Hold (reason required)
  Mark Completed

Owner sees:
  Who completed work
  Who placed work on hold
  Hold reason
  Live work-update feed
  Notification bell
  Server/client update status

IMPORTANT DATA SAFETY
---------------------
The existing live database stays at the installed MAIN SERVER location.
Updates use additive database migrations only; old CRM rows are not reset.
Pre-update backups are stored under:
  %LOCALAPPDATA%\NunesAI\CRMServer\App\backups\pre-update\

Known server fallback:
  <MAIN-SERVER-ADDRESS>
