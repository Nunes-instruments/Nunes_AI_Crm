param([switch]$Repair)
$ErrorActionPreference='Stop'
$install=Join-Path $env:LOCALAPPDATA 'NunesAI\CRMServer\App'
if(!(Test-Path -LiteralPath (Join-Path $install 'server.mjs'))){$install=Split-Path -Parent $PSScriptRoot}
$port=8765
$pf=Join-Path $install 'data\active_port.txt'
if(Test-Path -LiteralPath $pf){try{$p=[int](Get-Content -LiteralPath $pf -Raw).Trim();if($p -gt 0){$port=$p}}catch{}}
$base="http://127.0.0.1:$port"
Write-Host ''
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host ' NUNES AI CRM - TODAY / LIVE CRM CHECK' -ForegroundColor Cyan
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host ('Server : '+$base)
try{$health=Invoke-RestMethod -UseBasicParsing -Uri ($base+'/api/health') -TimeoutSec 5}catch{Write-Host ('[FAIL] Main CRM server is not responding: '+$_.Exception.Message) -ForegroundColor Red;exit 2}
$c=$health.company_crm
Write-Host ('Version             : '+$health.version)
Write-Host ('CRM configured      : '+$c.configured)
Write-Host ('LeadSphere server   : '+$c.base_url)
Write-Host ('Fast sync           : '+$c.sync_interval_seconds+' sec')
Write-Host ('Reconciliation      : '+$c.reconciliation_minutes+' min')
Write-Host ('Last successful sync: '+$c.last_successful_sync)
Write-Host ('Last error          : '+$c.last_error)
if($c.auto_sync){
  Write-Host ('Auto sync enabled   : '+$c.auto_sync.enabled)
  Write-Host ('Auto sync running   : '+$c.auto_sync.running)
  Write-Host ('Last auto attempt   : '+$c.auto_sync.last_attempt)
  Write-Host ('Last auto mode      : '+$c.auto_sync.last_mode)
  Write-Host ('Auto sync error     : '+$c.auto_sync.last_error)
}
if(-not $c.configured){
  Write-Host ''
  Write-Host '[PROBLEM] LeadSphere connection/key is not configured on this MAIN SERVER.' -ForegroundColor Red
  Write-Host 'Run CONFIGURE_COMPANY_CRM.bat and keep the existing server URL/API key.' -ForegroundColor Yellow
  exit 3
}
try{
  Write-Host ''
  Write-Host 'Testing LeadSphere connection...' -ForegroundColor Cyan
  $test=Invoke-RestMethod -UseBasicParsing -Method Post -Uri ($base+'/api/integrations/company-crm/test') -ContentType 'application/json' -Body '{}' -TimeoutSec 35
  Write-Host '[OK] LeadSphere connection test passed.' -ForegroundColor Green
}catch{
  Write-Host ('[FAIL] LeadSphere connection test failed: '+$_.Exception.Message) -ForegroundColor Red
  exit 4
}
if($Repair){
  try{
    Write-Host ''
    Write-Host 'Running immediate live incremental sync...' -ForegroundColor Cyan
    $r=Invoke-RestMethod -UseBasicParsing -Method Post -Uri ($base+'/api/integrations/company-crm/sync') -ContentType 'application/json' -Body '{"reconciliation":false}' -TimeoutSec 60
    $d=$r.data
    Write-Host ('[OK] Live sync: received '+$d.received+', new '+$d.inserted+', updated '+$d.updated+', unchanged '+$d.duplicates+', failed '+$d.failed) -ForegroundColor Green
    Write-Host 'Running today/recent reconciliation...' -ForegroundColor Cyan
    $r2=Invoke-RestMethod -UseBasicParsing -Method Post -Uri ($base+'/api/integrations/company-crm/sync') -ContentType 'application/json' -Body '{"reconciliation":true}' -TimeoutSec 90
    $d2=$r2.data
    Write-Host ('[OK] Reconcile: received '+$d2.received+', new '+$d2.inserted+', updated '+$d2.updated+', unchanged '+$d2.duplicates+', failed '+$d2.failed) -ForegroundColor Green
  }catch{
    Write-Host ('[FAIL] CRM sync failed: '+$_.Exception.Message) -ForegroundColor Red
    exit 5
  }
}
try{$live=Invoke-RestMethod -UseBasicParsing -Uri ($base+'/api/live-revision') -TimeoutSec 5;Write-Host ('Data revision        : '+$live.data.revision);Write-Host ('CRM last success     : '+$live.data.crm_last_success);Write-Host ('CRM current error    : '+$live.data.crm_last_error)}catch{}
Write-Host ''
Write-Host '[PASS] Main CRM and LeadSphere live connection are responding.' -ForegroundColor Green
if(-not $Repair){Write-Host 'For an immediate live pull, run REPAIR_LIVE_CRM_TODAY.bat.' -ForegroundColor Yellow}
exit 0
