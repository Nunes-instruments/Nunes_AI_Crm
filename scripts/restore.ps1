$ErrorActionPreference='Stop'
$Root=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Backups=Join-Path $Root 'backups'
$Data=Join-Path $Root 'data'
if(!(Test-Path $Backups)){Write-Host 'No backups folder found.' -ForegroundColor Yellow; exit 2}
$list=Get-ChildItem $Backups -Directory | Sort-Object LastWriteTime -Descending
if(!$list){Write-Host 'No CRM backups are available.' -ForegroundColor Yellow; exit 2}
Write-Host ''
Write-Host 'Available backups:' -ForegroundColor Cyan
for($i=0;$i -lt $list.Count;$i++){Write-Host ("[{0}] {1}   {2}" -f ($i+1),$list[$i].Name,$list[$i].LastWriteTime)}
Write-Host ''
$choice=Read-Host 'Enter backup number to restore (or press Enter to cancel)'
if(!$choice){exit 0}
$idx=0
if(![int]::TryParse($choice,[ref]$idx) -or $idx -lt 1 -or $idx -gt $list.Count){Write-Host 'Invalid selection.' -ForegroundColor Red; exit 3}
$selected=$list[$idx-1]
$db=Join-Path $selected.FullName 'nunes-crm.sqlite'
if(!(Test-Path $db)){Write-Host 'Selected backup does not contain nunes-crm.sqlite.' -ForegroundColor Red; exit 4}
$confirm=Read-Host "Restore $($selected.Name)? Current data will be replaced. Type YES to continue"
if($confirm -ne 'YES'){Write-Host 'Restore cancelled.';exit 0}
New-Item -ItemType Directory -Force -Path $Data | Out-Null
Copy-Item $db (Join-Path $Data 'nunes-crm.sqlite') -Force
Remove-Item (Join-Path $Data 'nunes-crm.sqlite-wal') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Data 'nunes-crm.sqlite-shm') -Force -ErrorAction SilentlyContinue
Write-Host 'CRM database restored successfully.' -ForegroundColor Green
