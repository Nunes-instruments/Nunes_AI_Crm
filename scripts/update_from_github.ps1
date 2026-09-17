param(
  [string]$Repo='Nunes-instruments/Nunes_AI_Crm',
  [string]$Branch='main',
  [string]$InstallRoot='',
  [switch]$Force,
  [switch]$Quiet
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

if([string]::IsNullOrWhiteSpace($InstallRoot)){
  $base=if($env:LOCALAPPDATA){$env:LOCALAPPDATA}else{Join-Path $env:USERPROFILE 'AppData\Local'}
  $InstallRoot=Join-Path $base 'NunesAI\CRMServer\App'
}
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$stateRoot=Split-Path -Parent $InstallRoot
$lockPath=Join-Path $stateRoot 'github-update.lock'
$triggerLock=Join-Path $InstallRoot 'data\github-update-started.lock'
$logDir=Join-Path $InstallRoot 'logs'
$logFile=Join-Path $logDir 'github-updater.log'
New-Item -ItemType Directory -Force -Path $stateRoot,$logDir | Out-Null

function Log([string]$Text){
  $line=('['+(Get-Date).ToString('yyyy-MM-dd HH:mm:ss')+'] '+$Text)
  try{Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8}catch{}
  if(!$Quiet){Write-Host $line}
}
function Parse-Version([string]$Text){
  $m=[regex]::Match(([string]$Text).Trim(),'^(?:v)?(\d+)\.(\d+)\.(\d+)')
  if(!$m.Success){throw "Invalid version: $Text"}
  return [Version]::new([int]$m.Groups[1].Value,[int]$m.Groups[2].Value,[int]$m.Groups[3].Value)
}
function Start-InstalledServer{
  try{
    $vbs=Join-Path $InstallRoot 'START_CRM_BACKGROUND.vbs'
    if(Test-Path -LiteralPath $vbs){Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" -ArgumentList ('"'+$vbs+'"') -WindowStyle Hidden | Out-Null;return}
    $bat=Join-Path $InstallRoot 'START_CRM_SERVER_ONLY.bat'
    if(Test-Path -LiteralPath $bat){Start-Process -FilePath $bat -ArgumentList '/background' -WindowStyle Hidden | Out-Null}
  }catch{Log ('Could not restart CRM automatically: '+$_.Exception.Message)}
}

# One updater process at a time. A stale lock older than 20 minutes is replaced.
try{
  if(Test-Path -LiteralPath $lockPath){
    $age=(Get-Date)-(Get-Item -LiteralPath $lockPath).LastWriteTime
    if($age.TotalMinutes -lt 20){Log 'Another GitHub update is already running. Exiting.';exit 0}
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  }
  [IO.File]::WriteAllText($lockPath,([Diagnostics.Process]::GetCurrentProcess().Id.ToString()),[Text.Encoding]::ASCII)

  $remoteVersionUrl="https://raw.githubusercontent.com/$Repo/$Branch/VERSION.txt?ts=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  Log "Checking GitHub $Repo ($Branch)..."
  $remoteText=(Invoke-WebRequest -UseBasicParsing -Uri $remoteVersionUrl -TimeoutSec 12 -Headers @{'User-Agent'='NUNES-AI-CRM-Updater';'Cache-Control'='no-cache'}).Content.Trim()
  $remote=Parse-Version $remoteText
  $local=[Version]'0.0.0'
  $localVersionFile=Join-Path $InstallRoot 'VERSION.txt'
  if(Test-Path -LiteralPath $localVersionFile){try{$local=Parse-Version (Get-Content -LiteralPath $localVersionFile -Raw)}catch{}}
  if(!$Force -and $remote -le $local){Log "Already current: $local";exit 0}
  Log "Update available: $local -> $remote"

  $tmp=Join-Path $env:TEMP ('NUNES_AI_CRM_GITHUB_'+[guid]::NewGuid().ToString('N'))
  $zip=Join-Path $tmp 'source.zip';$extract=Join-Path $tmp 'extract'
  New-Item -ItemType Directory -Force -Path $tmp,$extract | Out-Null
  try{
    $archiveUrl="https://github.com/$Repo/archive/refs/heads/$Branch.zip"
    Log 'Downloading verified GitHub branch archive...'
    Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -TimeoutSec 90 -OutFile $zip -Headers @{'User-Agent'='NUNES-AI-CRM-Updater';'Cache-Control'='no-cache'}
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    $source=Get-ChildItem -LiteralPath $extract -Directory | ForEach-Object {
      if(Test-Path -LiteralPath (Join-Path $_.FullName 'server.mjs')){$_.FullName}
    } | Select-Object -First 1
    if(!$source){throw 'Downloaded GitHub package does not contain server.mjs at repository root.'}
    foreach($required in @('VERSION.txt','server.mjs','public\app.js','scripts\install_local_server.ps1','scripts\update_from_github.ps1')){
      if(!(Test-Path -LiteralPath (Join-Path $source $required))){throw "GitHub package is incomplete: $required missing."}
    }
    $sourceVersion=Parse-Version (Get-Content -LiteralPath (Join-Path $source 'VERSION.txt') -Raw)
    if($sourceVersion -ne $remote){throw "GitHub VERSION.txt changed during download ($remote -> $sourceVersion). Try again on next check."}

    # Syntax validation before touching the installed server.
    $node=''
    $nodeHint=Join-Path $InstallRoot 'data\node_path.txt'
    if(Test-Path -LiteralPath $nodeHint){try{$node=(Get-Content -LiteralPath $nodeHint -Raw).Trim()}catch{}}
    if(!$node -or !(Test-Path -LiteralPath $node)){try{$node=(Get-Command node.exe -ErrorAction SilentlyContinue).Source}catch{}}
    if($node){
      foreach($file in @('server.mjs','public\app.js')){
        & $node '--check' (Join-Path $source $file) | Out-Null
        if($LASTEXITCODE -ne 0){throw "Syntax validation failed: $file"}
      }
    }

    # The existing install script creates a SQLite pre-update backup BEFORE stopping the old server,
    # then copies only program files. data/, backups/, logs/ and existing .env are preserved.
    Log 'Creating safety backup and installing changed program files...'
    & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $source 'scripts\install_local_server.ps1') -Quiet
    if($LASTEXITCODE -ne 0){throw "Install step failed with exit code $LASTEXITCODE"}
    Log "GitHub update installed successfully: $remote"
    Start-Sleep -Milliseconds 700
    Start-InstalledServer
  } finally {
    Remove-Item -LiteralPath $tmp -Force -Recurse -ErrorAction SilentlyContinue
  }
} catch {
  Log ('UPDATE FAILED: '+$_.Exception.Message)
  Start-InstalledServer
  exit 1
} finally {
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $triggerLock -Force -ErrorAction SilentlyContinue
}
exit 0
