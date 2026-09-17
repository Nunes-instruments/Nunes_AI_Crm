param([switch]$Quiet)
$ErrorActionPreference='Stop'

$SourceRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LocalBase = if($env:LOCALAPPDATA){$env:LOCALAPPDATA}else{Join-Path $env:USERPROFILE 'AppData\Local'}
$InstallRoot = Join-Path $LocalBase 'NunesAI\CRMServer\App'
$InstallParent = Split-Path -Parent $InstallRoot
$Port = 8765

function Same-Path([string]$A,[string]$B){
  try{
    $a1=[IO.Path]::GetFullPath($A).TrimEnd('\\').ToLowerInvariant()
    $b1=[IO.Path]::GetFullPath($B).TrimEnd('\\').ToLowerInvariant()
    return $a1 -eq $b1
  }catch{return $false}
}

function Copy-FileFast([string]$Source,[string]$Destination){
  $copy=$true
  if(Test-Path -LiteralPath $Destination){
    try{
      $s=Get-Item -LiteralPath $Source -Force
      $d=Get-Item -LiteralPath $Destination -Force
      # Size + UTC timestamp avoids re-copying the unchanged CRM on every update.
      if($s.Length -eq $d.Length -and [Math]::Abs(($s.LastWriteTimeUtc-$d.LastWriteTimeUtc).TotalSeconds) -lt 2){$copy=$false}
    }catch{}
  }
  if($copy){
    $parent=Split-Path -Parent $Destination
    if($parent -and !(Test-Path -LiteralPath $parent)){New-Item -ItemType Directory -Force -Path $parent | Out-Null}
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
  }
  return $copy
}

function Copy-TreeIncremental([string]$Source,[string]$Destination){
  if(!(Test-Path -LiteralPath $Source)){return 0}
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $count=0
  Get-ChildItem -LiteralPath $Source -Force -Recurse -File | ForEach-Object {
    $rel=$_.FullName.Substring($Source.Length).TrimStart('\\')
    if(Copy-FileFast $_.FullName (Join-Path $Destination $rel)){$count++}
  }
  return $count
}

function Get-ServerCandidates {
  $list=New-Object System.Collections.Generic.List[string]
  if($env:COMPUTERNAME){[void]$list.Add("http://$($env:COMPUTERNAME):$Port")}
  try{
    [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | ForEach-Object {
      if($_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork){
        $ip=$_.IPAddressToString
        if($ip -and $ip -notlike '127.*' -and $ip -notlike '169.254.*' -and $ip -ne '0.0.0.0'){
          [void]$list.Add("http://$ip`:$Port")
        }
      }
    }
  }catch{}
  # Tailscale command gives a stable 100.x address when installed.
  try{
    $tailscale=Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if($tailscale){
      $tip=(& $tailscale.Source ip -4 2>$null | Select-Object -First 1).Trim()
      if($tip){[void]$list.Insert(0,"http://$tip`:$Port")}
    }
  }catch{}
  return @($list | Select-Object -Unique)
}

function Publish-StaffServerConfig([string]$TargetRoot){
  try{
    if([string]::IsNullOrWhiteSpace($TargetRoot)){return}
    $cfgDir=Join-Path $TargetRoot 'config'
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    $obj=[ordered]@{
      version='2.11.4'
      port=$Port
      computer_name=$env:COMPUTERNAME
      candidates=@(Get-ServerCandidates)
      updated_at=(Get-Date).ToString('o')
    }
    $obj | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $cfgDir 'staff-server.json') -Encoding UTF8
  }catch{}
}

if(!$Quiet){
  Write-Host '====================================================' -ForegroundColor Cyan
  Write-Host '      NUNES AI CRM - FAST LOCAL SERVER SETUP' -ForegroundColor Cyan
  Write-Host '====================================================' -ForegroundColor Cyan
  Write-Host "Source: $SourceRoot" -ForegroundColor DarkGray
  Write-Host "Local:  $InstallRoot" -ForegroundColor DarkGray
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

# V2.10.0 DATA-SAFE UPDATE: before replacing any program files, make a consistent
# SQLite backup of the already-installed live CRM. Existing data is never copied
# over by an update. If a live database exists but a safety backup cannot be made,
# setup stops instead of risking historical staff/customer data.
if(!(Same-Path $SourceRoot $InstallRoot)){
  $liveDb=Join-Path $InstallRoot 'data\nunes-crm.sqlite'
  if(Test-Path -LiteralPath $liveDb){
    if(!$Quiet){Write-Host 'Creating automatic pre-update backup...' -ForegroundColor Cyan}
    $nodeExe=''
    $nodeHint=Join-Path $InstallRoot 'data\node_path.txt'
    if(Test-Path -LiteralPath $nodeHint){
      try{$candidate=(Get-Content -LiteralPath $nodeHint -Raw).Trim();if($candidate -and (Test-Path -LiteralPath $candidate)){$nodeExe=$candidate}}catch{}
    }
    if(!$nodeExe){
      try{$n=Get-Command node.exe -ErrorAction SilentlyContinue;if($n){$nodeExe=$n.Source}}catch{}
    }
    $backupScript=Join-Path $SourceRoot 'scripts\pre_update_backup.mjs'
    if(!$nodeExe -or !(Test-Path -LiteralPath $backupScript)){
      throw 'Safety backup could not start. Live CRM data was NOT changed. Check Node runtime and run setup again.'
    }
    $backupOut = & $nodeExe '--no-warnings' $backupScript $InstallRoot 2>&1
    if($LASTEXITCODE -ne 0){throw "Safety backup failed. Live CRM data was NOT changed. $backupOut"}
    if(!$Quiet){Write-Host "Backup ready: $($backupOut | Select-Object -Last 1)" -ForegroundColor Green}

    # Stop the old server only after its database backup has succeeded. This makes
    # updating server.mjs/public files deterministic and avoids half-old/half-new code.
    $stopBat=Join-Path $InstallRoot 'STOP_CRM.bat'
    if(Test-Path -LiteralPath $stopBat){
      try{& $stopBat /silent | Out-Null}catch{}
      Start-Sleep -Milliseconds 700
    }
  }
}

# Publish likely LAN/Tailscale addresses back into the shared setup folder.
# Staff setup can then auto-find the main server and does not need manual IP entry.
Publish-StaffServerConfig $SourceRoot

if(!(Same-Path $SourceRoot $InstallRoot)){
  $changed=0
  $skipTop=@('data','backups','logs')
  Get-ChildItem -LiteralPath $SourceRoot -Force | ForEach-Object {
    if($skipTop -contains $_.Name){return}
    if($_.Name -eq '.env'){
      $envTarget=Join-Path $InstallRoot '.env'
      if(!(Test-Path -LiteralPath $envTarget)){Copy-Item -LiteralPath $_.FullName -Destination $envTarget -Force; $script:changed++}
      return
    }
    $dest=Join-Path $InstallRoot $_.Name
    if($_.PSIsContainer){
      $script:changed += Copy-TreeIncremental $_.FullName $dest
    }else{
      if(Copy-FileFast $_.FullName $dest){$script:changed++}
    }
  }

  # First installation only: migrate existing live configuration/data.
  $srcData=Join-Path $SourceRoot 'data'
  $dstData=Join-Path $InstallRoot 'data'
  New-Item -ItemType Directory -Force -Path $dstData | Out-Null
  if(Test-Path -LiteralPath $srcData){
    Get-ChildItem -LiteralPath $srcData -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
      if($_.Name -in @('active_port.txt','crm.pid','node_path.txt')){return}
      if($_.Name -like '.crm_user_*'){return}
      $dest=Join-Path $dstData $_.Name
      if(!(Test-Path -LiteralPath $dest)){Copy-Item -LiteralPath $_.FullName -Destination $dest -Force}
    }
  }

  $srcBackups=Join-Path $SourceRoot 'backups'
  $dstBackups=Join-Path $InstallRoot 'backups'
  if(!(Test-Path -LiteralPath $dstBackups) -and (Test-Path -LiteralPath $srcBackups)){
    Copy-Item -LiteralPath $srcBackups -Destination $dstBackups -Recurse -Force
  }
  if(!$Quiet){Write-Host "Fast update copied $changed changed application file(s)." -ForegroundColor DarkGray}
}

New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot 'data'),(Join-Path $InstallRoot 'logs'),(Join-Path $InstallRoot 'backups') | Out-Null
Publish-StaffServerConfig $InstallRoot

# Main desktop shortcut. No admin rights needed.
try{
  $desktopHelper=Join-Path $InstallRoot 'scripts\create_desktop_icon.ps1'
  if(Test-Path -LiteralPath $desktopHelper){
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $desktopHelper -Mode Main | Out-Null
  }else{
    $desktop=[Environment]::GetFolderPath('DesktopDirectory')
    if([string]::IsNullOrWhiteSpace($desktop)){$desktop=[Environment]::GetFolderPath('Desktop')}
    if($desktop){
      $w=New-Object -ComObject WScript.Shell
      $s=$w.CreateShortcut((Join-Path $desktop 'NUNES AI CRM - SERVER.lnk'))
      $s.TargetPath=(Join-Path $InstallRoot 'OPEN_NUNES_CRM.bat')
      $s.WorkingDirectory=$InstallRoot
      $icon=Join-Path $InstallRoot 'assets\NUNES_AI_CRM.ico'
      if(Test-Path -LiteralPath $icon){$s.IconLocation="$icon,0"}
      $s.Description='NUNES AI CRM - Main Server Console'
      $s.Save()
    }
  }
}catch{if(!$Quiet){Write-Warning "Desktop shortcut could not be created: $($_.Exception.Message)"}}

# Auto-start server at sign-in, silently in background.
try{
  $startup=[Environment]::GetFolderPath('Startup')
  if($startup){
    $w=New-Object -ComObject WScript.Shell
    $s=$w.CreateShortcut((Join-Path $startup 'NUNES AI CRM Server.lnk'))
    $s.TargetPath="$env:WINDIR\System32\wscript.exe"
    $s.Arguments='"'+(Join-Path $InstallRoot 'START_CRM_BACKGROUND.vbs')+'"'
    $s.WorkingDirectory=$InstallRoot
    $s.Description='Starts NUNES AI CRM server in the background at Windows sign-in'
    $s.Save()
  }
}catch{if(!$Quiet){Write-Warning "Windows startup shortcut could not be created: $($_.Exception.Message)"}}

[IO.File]::WriteAllText((Join-Path $InstallParent 'install_path.txt'),$InstallRoot,[Text.Encoding]::UTF8)
if(!$Quiet){
  Write-Host ''
  Write-Host 'Local CRM server installation is ready.' -ForegroundColor Green
  Write-Host 'Future upgrades copy only changed program files.' -ForegroundColor Green
  Write-Host 'The live database remains safely on this main computer.' -ForegroundColor Green
}
Write-Output $InstallRoot
