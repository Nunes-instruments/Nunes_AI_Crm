param([string]$Root='')
$ErrorActionPreference='Stop'

# V2.9.1: never trust a command-line folder that ends in a backslash.
# Windows argument parsing can turn "C:\folder\" into a value containing a
# literal quote character. That makes Test-Path throw "Illegal characters in path".
# The launcher lives in <CRM>\scripts, so the safest source of truth is its own path.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DetectedRoot = Split-Path -Parent $ScriptDir

function Normalize-CrmRoot([string]$Value){
  if([string]::IsNullOrWhiteSpace($Value)){ return [IO.Path]::GetFullPath($DetectedRoot) }
  $v=$Value.Trim().Trim('"')
  # Strip accidental trailing quote(s) first, then harmless trailing separators.
  while($v.EndsWith('"')){ $v=$v.Substring(0,$v.Length-1).TrimEnd() }
  while($v.Length -gt 3 -and ($v.EndsWith('\') -or $v.EndsWith('/'))){ $v=$v.Substring(0,$v.Length-1) }
  try{
    $full=[IO.Path]::GetFullPath($v)
    if(Test-Path -LiteralPath (Join-Path $full 'server.mjs')){ return $full }
  }catch{}
  return [IO.Path]::GetFullPath($DetectedRoot)
}

$Root = Normalize-CrmRoot $Root

function Test-Crm([int]$Port){
  try{
    $r=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 1
    return $r.app -eq 'NUNES_AI_CRM_V1'
  }catch{return $false}
}

function Get-ActivePort{
  $pf=Join-Path $Root 'data\active_port.txt'
  if(Test-Path -LiteralPath $pf){
    try{
      $raw=(Get-Content -LiteralPath $pf -Raw -ErrorAction Stop).Trim()
      $p=0
      if([int]::TryParse($raw,[ref]$p) -and $p -ge 1 -and $p -le 65535){return $p}
    }catch{}
  }
  return 8765
}

function Find-Browser{
  $candidates=@()
  if(${env:ProgramFiles(x86)}){
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
  }
  if($env:ProgramFiles){
    $candidates += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    $candidates += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe')
  }
  if($env:LOCALAPPDATA){$candidates += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')}
  $available=@($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
  if($available.Count){return $available[0]}
  return $null
}

$port=Get-ActivePort
if(!(Test-Crm $port)){
  $starter=Join-Path $Root 'START_CRM_SERVER_ONLY.bat'
  if(!(Test-Path -LiteralPath $starter)){ throw "CRM server launcher is missing: $starter" }
  Start-Process -FilePath $starter -WorkingDirectory $Root -WindowStyle Hidden
  $ready=$false
  for($i=0;$i -lt 60;$i++){
    Start-Sleep -Milliseconds 350
    $port=Get-ActivePort
    if(Test-Crm $port){$ready=$true;break}
  }
  if(!$ready){throw 'NUNES AI CRM server did not start. Open logs\server-console.log for the exact reason.'}
}

$url="http://127.0.0.1:$port/#/server"
$browser=Find-Browser
if($browser){
  Start-Process -FilePath $browser -ArgumentList @("--app=$url",'--start-maximized')
}else{
  Start-Process $url
}
