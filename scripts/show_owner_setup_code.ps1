$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '         NUNES AI CRM - OWNER SETUP CODE' -ForegroundColor Cyan
Write-Host '====================================================' -ForegroundColor Cyan

$LocalBase=if($env:LOCALAPPDATA){$env:LOCALAPPDATA}else{Join-Path $env:USERPROFILE 'AppData\Local'}
$AppRoot=Join-Path $LocalBase 'NunesAI\CRMServer\App'
$PortFile=Join-Path $AppRoot 'data\active_port.txt'
$StartFile=Join-Path $AppRoot 'START_CRM_SERVER_ONLY.bat'
$StopFile=Join-Path $AppRoot 'STOP_CRM.bat'
$CodeFile=Join-Path $AppRoot 'data\OWNER_SETUP_CODE.txt'

function Get-CrmPort {
  $p=8765
  if(Test-Path -LiteralPath $PortFile){
    try{
      $raw=(Get-Content -LiteralPath $PortFile -Raw -ErrorAction Stop).Trim()
      $n=0
      if([int]::TryParse($raw,[ref]$n) -and $n -ge 1 -and $n -le 65535){$p=$n}
    }catch{}
  }
  return $p
}

function Get-Health([int]$Port){
  try{return Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2}catch{return $null}
}

function Wait-ForServer([int]$Seconds=25){
  $deadline=(Get-Date).AddSeconds($Seconds)
  do{
    $port=Get-CrmPort
    $health=Get-Health $port
    if($health -and $health.app -eq 'NUNES_AI_CRM_V1'){return @{port=$port;health=$health}}
    Start-Sleep -Milliseconds 350
  }while((Get-Date) -lt $deadline)
  return $null
}

function Start-LatestServer {
  if(!(Test-Path -LiteralPath $StartFile)){throw "Local CRM server is not installed. Run 1_SETUP_MAIN_CRM_SERVER.bat first."}
  Start-Process -FilePath $StartFile -WorkingDirectory $AppRoot -WindowStyle Hidden
  $ready=Wait-ForServer 25
  if(!$ready){throw "The local CRM server did not start. Check $AppRoot\logs\server-console.log"}
  return $ready
}

if(!(Test-Path -LiteralPath $AppRoot)){
  throw 'Local CRM server is not installed yet. Run 1_SETUP_MAIN_CRM_SERVER.bat first.'
}

$ready=Wait-ForServer 2
if(!$ready){
  Write-Host 'Starting the local CRM server...' -ForegroundColor DarkGray
  $ready=Start-LatestServer
}

# V2.10.0 endpoint exists only on the updated server. If an older server process
# is still occupying the port after an upgrade, restart once so the new code runs.
$port=[int]$ready.port
$health=$ready.health
$needsRestart=([string]$health.version -ne '2.11.4')
if(!$needsRestart){
  try{
    $reply=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/api/device/owner-setup-code" -TimeoutSec 3
  }catch{$reply=$null;$needsRestart=$true}
}

if($needsRestart){
  Write-Host 'Activating the latest CRM update...' -ForegroundColor DarkGray
  if(Test-Path -LiteralPath $StopFile){
    & cmd.exe /d /c ('"'+$StopFile+'" /silent') | Out-Null
    Start-Sleep -Milliseconds 800
  }
  $ready=Start-LatestServer
  $port=[int]$ready.port
  $reply=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/api/device/owner-setup-code" -TimeoutSec 5
}

$code=[string]$reply.data.setup_code
if([string]::IsNullOrWhiteSpace($code)){
  # Last-resort local file read. Normally the local-only endpoint above repairs
  # the file/hash automatically before returning.
  if(Test-Path -LiteralPath $CodeFile){$code=(Get-Content -LiteralPath $CodeFile -Raw).Trim()}
}
if([string]::IsNullOrWhiteSpace($code)){throw 'The owner setup code could not be generated.'}

Write-Host ''
Write-Host ('OWNER SETUP CODE: '+$code) -ForegroundColor Green
Write-Host ''
Write-Host 'Use this code once on the OWNER computer when running SETUP_OWNER_PC.bat.' -ForegroundColor White
Write-Host 'After the owner PC is linked, the server automatically replaces this code.' -ForegroundColor DarkGray
Write-Host 'Do not give this code to staff.' -ForegroundColor Yellow
try{Set-Clipboard -Value $code -ErrorAction Stop;Write-Host 'The code was also copied to the clipboard.' -ForegroundColor DarkGray}catch{}
exit 0
