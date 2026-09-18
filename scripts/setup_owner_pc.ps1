$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '       NUNES AI CRM - OWNER PC SETUP' -ForegroundColor Cyan
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host 'Overall company view. No Node.js, npm or database on this PC.' -ForegroundColor DarkGray
$ScriptDir=Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageRoot=Split-Path -Parent $ScriptDir
$LocalBase=if($env:LOCALAPPDATA){$env:LOCALAPPDATA}else{Join-Path $env:USERPROFILE 'AppData\Local'}
$common=Join-Path $LocalBase 'NunesAI\CRMOwner';New-Item -ItemType Directory -Force -Path $common | Out-Null
function Normalize-Server([string]$s){if([string]::IsNullOrWhiteSpace($s)){return $null};$s=$s.Trim().TrimEnd('/');if($s -notmatch '^https?://'){$s='http://'+$s};try{$u=[Uri]$s;if($u.IsDefaultPort -and $s -notmatch ':\d+$'){$s=$s+':8765'};return $s}catch{return $null}}
function Test-CrmServer([string]$s,[int]$Timeout=2){try{$n=Normalize-Server $s;if(!$n){return $null};$h=Invoke-RestMethod -UseBasicParsing -Uri "$n/api/health" -TimeoutSec $Timeout;if($h.app -eq 'NUNES_AI_CRM_V1'){return $n}}catch{};return $null}
$candidates=New-Object 'System.Collections.Generic.List[string]'
[void]$candidates.Add('http://192.168.29.194:8765')
[void]$candidates.Add('http://100.97.196.17:8765')
$last=Join-Path $common 'client.json';if(Test-Path -LiteralPath $last){try{$x=(Get-Content -LiteralPath $last -Raw|ConvertFrom-Json).server_url;if($x){[void]$candidates.Add([string]$x)}}catch{}}
$published=Join-Path $PackageRoot 'config\staff-server.json';if(Test-Path -LiteralPath $published){try{@((Get-Content -LiteralPath $published -Raw|ConvertFrom-Json).candidates)|ForEach-Object{if($_ -and !$candidates.Contains([string]$_)){[void]$candidates.Add([string]$_)}}}catch{}}
$server=$null;foreach($c in @($candidates)){$server=Test-CrmServer $c 2;if($server){break}}
if(!$server){$server=Test-CrmServer (Read-Host 'Enter MAIN CRM server address (PC name / LAN IP / Tailscale IP)') 5}
if(!$server){throw 'Cannot reach the main CRM server.'}
Write-Host "Connected: $server" -ForegroundColor Green
$code=(Read-Host 'Enter OWNER SETUP CODE from SHOW_OWNER_SETUP_CODE.bat on the server').Trim()
if([string]::IsNullOrWhiteSpace($code)){throw 'Owner setup code is required.'}
$body=@{setup_code=$code;device_name="$env:COMPUTERNAME / $env:USERNAME"}|ConvertTo-Json
try{$reg=Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$server/api/device/register-owner" -ContentType 'application/json' -Body $body -TimeoutSec 8}catch{throw "Owner PC could not be linked: $($_.Exception.Message)"}
$token=[string]$reg.data.device_token;$user=$reg.data.user;if([string]::IsNullOrWhiteSpace($token)){throw 'The server did not return an owner device token.'}
$launcher=Join-Path $common 'open_staff_app.ps1';Copy-Item -LiteralPath (Join-Path $ScriptDir 'open_staff_app.ps1') -Destination $launcher -Force
$config=Join-Path $common 'client.json';@{server_url=$server;server_candidates=@($candidates);user_id=$user.id;user_name=$user.name;device_token=$token;device_type='OWNER';configured_at=(Get-Date).ToString('o');client_version='2.11.13'}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $config -Encoding UTF8
$cmd=Join-Path $common 'OPEN_NUNES_AI_CRM_OWNER.cmd';$cmdText='@echo off'+"`r`n"+'start "" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+$launcher+'" -ConfigPath "'+$config+'"'+"`r`n";[IO.File]::WriteAllText($cmd,$cmdText,[Text.Encoding]::ASCII)
$iconSource=Join-Path $PackageRoot 'assets\NUNES_AI_CRM.ico';$iconLocal=Join-Path $common 'NUNES_AI_CRM.ico';if(Test-Path -LiteralPath $iconSource){Copy-Item -LiteralPath $iconSource -Destination $iconLocal -Force}
$helper=Join-Path $ScriptDir 'create_desktop_icon.ps1';if(Test-Path -LiteralPath $helper){& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $helper -Mode Staff -TargetPath $cmd -WorkingDirectory $common -DisplayName 'NUNES AI CRM - OWNER' -Description 'NUNES AI CRM - Owner Overall Company View' -IconPath $iconLocal | Out-Null}
Write-Host '';Write-Host 'OWNER PC READY.' -ForegroundColor Green;Write-Host 'The owner sees the overall dashboard, all 10 staff, all leads and overall reports.' -ForegroundColor Green;Write-Host 'WhatsApp and Gmail remain personal to this owner computer/browser.' -ForegroundColor DarkGray
Start-Process -FilePath $cmd
