$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '       NUNES AI CRM - FAST STAFF PC SETUP' -ForegroundColor Cyan
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'No Node.js. No npm. No database. No Administrator setup.' -ForegroundColor DarkGray
Write-Host 'This PC only receives a small desktop client linked to the main CRM.' -ForegroundColor DarkGray
Write-Host ''

$ScriptDir=Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageRoot=Split-Path -Parent $ScriptDir
$LocalBase=if($env:LOCALAPPDATA){$env:LOCALAPPDATA}else{Join-Path $env:USERPROFILE 'AppData\Local'}
$common=Join-Path $LocalBase 'NunesAI\CRMStaff'
New-Item -ItemType Directory -Force -Path $common | Out-Null

function Normalize-Server([string]$s){
  if([string]::IsNullOrWhiteSpace($s)){return $null}
  $s=$s.Trim().TrimEnd('/')
  if($s -notmatch '^https?://'){$s='http://'+$s}
  try{
    $u=[Uri]$s
    if($u.IsDefaultPort -and $s -notmatch ':\d+$'){$s=$s+':8765'}
    return $s
  }catch{return $null}
}

function Test-CrmServer([string]$s,[int]$Timeout=2){
  try{
    $n=Normalize-Server $s
    if(!$n){return $null}
    $h=Invoke-RestMethod -UseBasicParsing -Uri "$n/api/health" -TimeoutSec $Timeout
    if($h.app -eq 'NUNES_AI_CRM_V1'){return $n}
  }catch{}
  return $null
}

function Add-Candidate([System.Collections.Generic.List[string]]$List,[string]$Value){
  $v=Normalize-Server $Value
  if($v -and !$List.Contains($v)){[void]$List.Add($v)}
}

$candidates=New-Object 'System.Collections.Generic.List[string]'
# Known MAIN server addresses. Office LAN is tried first, then Tailscale.
Add-Candidate $candidates 'http://192.168.29.194:8765'
Add-Candidate $candidates 'http://100.97.196.17:8765'

# Fastest: reuse the server from a previous setup on this staff PC.
try{
  Get-ChildItem -LiteralPath $common -Filter client.json -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    try{Add-Candidate $candidates ((Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).server_url)}catch{}
  }
}catch{}

# Then use the server list published by MAIN setup into the shared/NAS package.
$published=Join-Path $PackageRoot 'config\staff-server.json'
if(Test-Path -LiteralPath $published){
  try{
    $pcfg=Get-Content -LiteralPath $published -Raw | ConvertFrom-Json
    @($pcfg.candidates) | ForEach-Object {Add-Candidate $candidates ([string]$_)}
  }catch{}
}

$server=$null
foreach($c in @($candidates)){
  Write-Host "Checking main CRM: $c" -ForegroundColor DarkGray
  $server=Test-CrmServer $c 2
  if($server){break}
}

if(!$server){
  $manual=Read-Host 'Enter MAIN CRM server address (PC name / LAN IP / Tailscale IP)'
  $server=Test-CrmServer $manual 5
  if(!$server){throw 'Cannot reach the main CRM. Make sure the main server is ON, connected to LAN/Tailscale, and firewall access is enabled.'}
}else{
  Write-Host "Connected automatically: $server" -ForegroundColor Green
}

# Get live staff profiles from the one central CRM.
# Do not fail permanently when a newly joined employee is not in the list.
# The Owner can add the profile in Owner Settings -> Sales Team Profiles, then this screen can refresh immediately.
$previousId=$null
$lastCfg=Join-Path $common 'last_staff.json'
if(Test-Path -LiteralPath $lastCfg){try{$previousId=[int]((Get-Content -LiteralPath $lastCfg -Raw | ConvertFrom-Json).user_id)}catch{}}

function Get-LiveStaffUsers {
  try{
    $response=Invoke-RestMethod -UseBasicParsing -Uri "$server/api/team/users" -TimeoutSec 5
    return @($response.data | Where-Object { $_.active -ne 0 -and ([string]$_.role).ToUpperInvariant() -eq 'SALESPERSON' })
  }catch{
    throw "Connected to the server, but staff profiles could not be loaded: $($_.Exception.Message)"
  }
}

$user=$null
while(!$user){
  $users=@(Get-LiveStaffUsers)
  Write-Host ''
  Write-Host 'Choose this computer staff profile:' -ForegroundColor Yellow
  if($users.Count -gt 0){
    for($i=0;$i -lt $users.Count;$i++){
      $u=$users[$i]
      $mark=if($previousId -and [int]$u.id -eq $previousId){'  [THIS PC - PREVIOUS]'}else{''}
      $designation=if($u.designation){" - $($u.designation)"}else{''}
      Write-Host ("[{0}] {1}{2}{3}" -f ($i+1),$u.name,$designation,$mark)
    }
  }else{
    Write-Host 'No active staff profiles are currently available on the MAIN server.' -ForegroundColor Red
  }
  Write-Host ''
  Write-Host '[R] Refresh staff list' -ForegroundColor Cyan
  Write-Host '[0] My staff name is NOT in this list' -ForegroundColor Cyan
  Write-Host '[X] Exit setup' -ForegroundColor DarkGray
  Write-Host ''

  if($previousId -and ($users | Where-Object {[int]$_.id -eq $previousId})){
    $prev=$users | Where-Object {[int]$_.id -eq $previousId} | Select-Object -First 1
    $answer=Read-Host "Press ENTER to keep $($prev.name), choose 1-$($users.Count), R, 0, or X"
    if([string]::IsNullOrWhiteSpace($answer)){$user=$prev;break}
  }else{
    $answer=Read-Host "Choose 1-$($users.Count), R, 0, or X"
  }

  $choice=String($answer).Trim()
  if($choice -match '^[Rr]$'){continue}
  if($choice -match '^[Xx]$'){Write-Host 'Staff setup cancelled.' -ForegroundColor Yellow;exit 0}
  if($choice -eq '0'){
    Write-Host ''
    Write-Host 'THIS STAFF IS NOT YET IN THE MAIN CRM STAFF LIST.' -ForegroundColor Yellow
    Write-Host 'On the OWNER computer open: Owner Settings -> Sales Team Profiles -> Add Staff.' -ForegroundColor White
    Write-Host 'Add/activate the employee once. Do NOT create a separate database on this PC.' -ForegroundColor DarkGray
    Write-Host 'After the Owner saves the staff profile, come back here and press ENTER to refresh.' -ForegroundColor Green
    Read-Host 'Press ENTER after the Owner has added the staff' | Out-Null
    continue
  }
  $n=0
  if([int]::TryParse($choice,[ref]$n) -and $n -ge 1 -and $n -le $users.Count){$user=$users[$n-1];break}
  # Backward compatibility: also accept the actual CRM user ID if somebody already knows it.
  $idMatch=$users | Where-Object {[string]$_.id -eq $choice} | Select-Object -First 1
  if($idMatch){$user=$idMatch;break}
  Write-Host 'Invalid choice. Select the number shown next to the staff name.' -ForegroundColor Red
}
$id=[int]$user.id

$deviceName="$env:COMPUTERNAME / $env:USERNAME"
try{
  $regBody=@{user_id=$id;device_name=$deviceName} | ConvertTo-Json
  $registered=Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$server/api/device/register-staff" -ContentType 'application/json' -Body $regBody -TimeoutSec 8
  $deviceToken=[string]$registered.data.device_token
  if([string]::IsNullOrWhiteSpace($deviceToken)){throw 'The server did not return a staff device token.'}
}catch{throw "Staff profile could not be linked to this PC: $($_.Exception.Message)"}

$profile=Join-Path $common ([string]$id)
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$sourceScript=Join-Path $ScriptDir 'open_staff_app.ps1'
$launcherScript=Join-Path $common 'open_staff_app.ps1'
Copy-Item -LiteralPath $sourceScript -Destination $launcherScript -Force
$config=Join-Path $profile 'client.json'
@{server_url=$server;user_id=$id;user_name=$user.name;device_token=$deviceToken;device_type='STAFF';configured_at=(Get-Date).ToString('o');client_version='2.11.3'} | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8
@{server_url=$server;user_id=$id;user_name=$user.name} | ConvertTo-Json | Set-Content -LiteralPath $lastCfg -Encoding UTF8

# Tiny CMD launcher avoids PowerShell quoting problems on NAS paths.
$cmd=Join-Path $profile 'OPEN_NUNES_AI_CRM.cmd'
$cmdText='@echo off'+"`r`n"+'start "" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+$launcherScript+'" -ConfigPath "'+$config+'"'+"`r`n"
[IO.File]::WriteAllText($cmd,$cmdText,[Text.Encoding]::ASCII)

$safe=([string]$user.name -replace '[\\/:*?"<>|]','').Trim()
$iconSource=Join-Path $PackageRoot 'assets\NUNES_AI_CRM.ico'
$iconLocal=Join-Path $common 'NUNES_AI_CRM.ico'
if(Test-Path -LiteralPath $iconSource){Copy-Item -LiteralPath $iconSource -Destination $iconLocal -Force}
$desktopHelper=Join-Path $ScriptDir 'create_desktop_icon.ps1'
if(Test-Path -LiteralPath $desktopHelper){
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $desktopHelper -Mode Staff -TargetPath $cmd -WorkingDirectory $profile -DisplayName ("NUNES AI CRM - $safe") -Description ("NUNES AI CRM - $($user.name)") -IconPath $iconLocal | Out-Null
}else{
  $desktop=[Environment]::GetFolderPath('DesktopDirectory')
  if([string]::IsNullOrWhiteSpace($desktop)){$desktop=[Environment]::GetFolderPath('Desktop')}
  $link=Join-Path $desktop ("NUNES AI CRM - $safe.lnk")
  $w=New-Object -ComObject WScript.Shell
  $s=$w.CreateShortcut($link)
  $s.TargetPath=$cmd
  $s.WorkingDirectory=$profile
  if(Test-Path -LiteralPath $iconLocal){$s.IconLocation="$iconLocal,0"}
  $s.Description="NUNES AI CRM - $($user.name)"
  $s.Save()
}

Write-Host ''
Write-Host "READY - Desktop app created for $($user.name)." -ForegroundColor Green
Write-Host 'This PC does not need the CRM ZIP again for normal daily use.' -ForegroundColor Green
Write-Host 'Future CRM page/function updates come automatically from the main server.' -ForegroundColor Green
Write-Host 'This PC is locked to this staff profile; owner reports and other staff enquiries are blocked.' -ForegroundColor Green
Write-Host 'WhatsApp and Gmail remain personal to this Windows/browser login.' -ForegroundColor DarkGray
Start-Process -FilePath $cmd
