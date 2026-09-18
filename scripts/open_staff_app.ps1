param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
$ClientVersion='2.11.13'
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

$KnownLanServer='http://192.168.29.194:8765'
$KnownTailscaleServer='http://100.97.196.17:8765'

function Normalize-Server([string]$Value){
  if([string]::IsNullOrWhiteSpace($Value)){return $null}
  $s=$Value.Trim().TrimEnd('/')
  if($s -notmatch '^https?://'){$s='http://'+$s}
  try{
    $u=[Uri]$s
    if($u.IsDefaultPort -and $s -notmatch ':\d+$'){$s=$s+':8765'}
    return $s
  }catch{return $null}
}
function Test-CrmServer([string]$Value,[int]$Timeout=2){
  try{
    $s=Normalize-Server $Value
    if(!$s){return $null}
    $h=Invoke-RestMethod -UseBasicParsing -Uri "$s/api/health" -TimeoutSec $Timeout
    if($h.app -eq 'NUNES_AI_CRM_V1'){return $s}
  }catch{}
  return $null
}
function Add-ServerCandidate([System.Collections.Generic.List[string]]$List,[string]$Value){
  $s=Normalize-Server $Value
  if($s -and !$List.Contains($s)){[void]$List.Add($s)}
}

function Show-Error([string]$Message){
  try{[System.Windows.Forms.MessageBox]::Show($Message,'NUNES AI CRM',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Warning)|Out-Null}catch{Write-Host $Message}
}
function Find-Browser{
  $items=@()
  if(${env:ProgramFiles(x86)}){
    $items += @{p=(Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe');mode='chromium'}
    $items += @{p=(Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe');mode='chromium'}
    $items += @{p=(Join-Path ${env:ProgramFiles(x86)} 'BraveSoftware\Brave-Browser\Application\brave.exe');mode='chromium'}
  }
  if($env:ProgramFiles){
    $items += @{p=(Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe');mode='chromium'}
    $items += @{p=(Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe');mode='chromium'}
    $items += @{p=(Join-Path $env:ProgramFiles 'BraveSoftware\Brave-Browser\Application\brave.exe');mode='chromium'}
    $items += @{p=(Join-Path $env:ProgramFiles 'Mozilla Firefox\firefox.exe');mode='normal'}
  }
  if($env:LOCALAPPDATA){
    $items += @{p=(Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe');mode='chromium'}
    $items += @{p=(Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe');mode='chromium'}
    $items += @{p=(Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe');mode='chromium'}
  }
  foreach($b in $items){if($b.p -and (Test-Path -LiteralPath $b.p)){return $b}}
  return $null
}
function Save-ConfigVersion($cfg,[string]$Version){
  try{
    $cfg.client_version=$Version
    $cfg.last_update_check=(Get-Date).ToString('o')
    $cfg | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
  }catch{}
}
function Try-SelfUpdate([string]$Server,[string]$Token,$Cfg){
  try{
    $headers=@{'X-Nunes-Device-Token'=$Token;'X-Nunes-Client-Version'=$ClientVersion}
    $m=Invoke-RestMethod -UseBasicParsing -Uri "$Server/api/client/update-manifest?client_version=$([Uri]::EscapeDataString($ClientVersion))" -Headers $headers -TimeoutSec 3
    if(!$m -or !$m.data){return $false}
    $remote=[string]$m.data.launcher_version
    Save-ConfigVersion $Cfg $ClientVersion
    if(!$m.data.update_available -or [string]::IsNullOrWhiteSpace($remote)){return $false}

    $self=[string]$MyInvocation.MyCommand.Path
    if([string]::IsNullOrWhiteSpace($self) -or !(Test-Path -LiteralPath $self)){return $false}
    $tmp="$self.new"
    Invoke-WebRequest -UseBasicParsing -Uri "$Server$($m.data.launcher_url)" -Headers $headers -TimeoutSec 8 -OutFile $tmp
    $hash=(Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
    if($hash -ne ([string]$m.data.launcher_sha256).ToLowerInvariant()){Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue;return $false}
    Move-Item -LiteralPath $tmp -Destination $self -Force
    $Cfg.client_version=$remote
    $Cfg.last_update_applied=(Get-Date).ToString('o')
    $Cfg | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
    try{
      $body=@{client_version=$remote}|ConvertTo-Json
      Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$Server/api/client/update-applied" -Headers @{'X-Nunes-Device-Token'=$Token} -ContentType 'application/json' -Body $body -TimeoutSec 3 | Out-Null
    }catch{}
    Start-Process powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$self,'-ConfigPath',$ConfigPath)
    return $true
  }catch{
    # Update check must never stop staff from opening CRM.
    return $false
  }
}

if(!(Test-Path -LiteralPath $ConfigPath)){Show-Error 'CRM desktop setup is missing. Run the Owner or Staff PC setup once.';exit 1}
$c=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$token=[string]$c.device_token
if([string]::IsNullOrWhiteSpace($token)){Show-Error 'This desktop app uses an old setup. Run the Owner or Staff PC setup once to securely link this computer.';exit 1}

# V2.11.13 NETWORK FALLBACK:
# Always try the current office LAN first, then saved/discovered addresses, then Tailscale.
# If the working address changes, save it automatically. No staff IP typing is needed.
$candidates=New-Object 'System.Collections.Generic.List[string]'
Add-ServerCandidate $candidates $KnownLanServer
try{@($c.server_candidates) | ForEach-Object {Add-ServerCandidate $candidates ([string]$_)}}catch{}
Add-ServerCandidate $candidates ([string]$c.server_url)
Add-ServerCandidate $candidates $KnownTailscaleServer
$server=$null
foreach($candidate in @($candidates)){
  $server=Test-CrmServer $candidate 2
  if($server){break}
}
if(!$server){
  Show-Error "The main NUNES AI CRM server is not reachable.`n`nLAN: $KnownLanServer`nTailscale: $KnownTailscaleServer`n`nMake sure the MAIN SERVER PC is ON and LAN/Tailscale is connected."
  exit 2
}
try{
  if(([string]$c.server_url).TrimEnd('/') -ne $server){
    $c.server_url=$server
    $c.server_candidates=@($candidates)
    $c.last_server_switch=(Get-Date).ToString('o')
    $c | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
  }
}catch{}

# From V2.10.0 onward, every Owner/Staff desktop launcher updates itself from the main server.
# CRM page/function changes are central and already appear immediately without a client reinstall.
if(Try-SelfUpdate $server $token $c){exit 0}

$encoded=[Uri]::EscapeDataString($token)
$url="$server/#/dashboard?device_token=$encoded"
$browser=Find-Browser
if($browser){
  if($browser.mode -eq 'chromium'){Start-Process -FilePath $browser.p -ArgumentList @("--app=$url",'--start-maximized')}
  else{Start-Process -FilePath $browser.p -ArgumentList @($url)}
}else{Start-Process $url}
