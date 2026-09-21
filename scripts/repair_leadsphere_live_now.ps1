$ErrorActionPreference='Stop'

function Write-Title($t){Write-Host '';Write-Host '====================================================' -ForegroundColor Cyan;Write-Host (' '+$t) -ForegroundColor Cyan;Write-Host '====================================================' -ForegroundColor Cyan}
function Clean([string]$s){if($null -eq $s){return ''};return $s.Trim().Trim([char]0xFEFF)}
function Test-TcpQuick([string]$HostName,[int]$Port,[int]$TimeoutMs=1800){
  $c=New-Object System.Net.Sockets.TcpClient
  try{$ar=$c.BeginConnect($HostName,$Port,$null,$null);if(-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)){return $false};$c.EndConnect($ar);return $true}catch{return $false}finally{$c.Close()}
}
function Find-TailscaleExe{
  $cmd=Get-Command tailscale.exe -ErrorAction SilentlyContinue;if($cmd){return $cmd.Source}
  foreach($p in @('C:\Program Files\Tailscale\tailscale.exe','C:\Program Files (x86)\Tailscale\tailscale.exe')){if(Test-Path -LiteralPath $p){return $p}}
  return ''
}
function Get-TailscalePeerIps([string]$WantedHost){
  $exe=Find-TailscaleExe;if(-not $exe){return @()}
  try{$j=(& $exe status --json 2>$null | Out-String | ConvertFrom-Json -ErrorAction Stop)}catch{return @()}
  $short=($WantedHost.ToLowerInvariant().TrimEnd('.') -split '\.')[0];$out=New-Object System.Collections.Generic.List[string]
  foreach($prop in $j.Peer.PSObject.Properties){
    $peer=$prop.Value;$dns=([string]$peer.DNSName).ToLowerInvariant().TrimEnd('.');$hn=([string]$peer.HostName).ToLowerInvariant()
    if($dns -eq $WantedHost.ToLowerInvariant().TrimEnd('.') -or $dns.StartsWith($short+'.') -or $hn -eq $short){
      foreach($ip in @($peer.TailscaleIPs)){if([string]$ip -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'){[void]$out.Add([string]$ip)}}
    }
  }
  return @($out | Select-Object -Unique)
}

$scriptRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRoot=Split-Path -Parent $scriptRoot
$install=Join-Path $env:LOCALAPPDATA 'NunesAI\CRMServer\App'
if(-not (Test-Path -LiteralPath (Join-Path $install 'server.mjs'))){$install=$packageRoot}
$data=Join-Path $install 'data';$cfgPath=Join-Path $data 'company-crm.json';$keyPath=Join-Path $data 'company-crm-key.txt'
Write-Title 'NUNES AI CRM - LEADSPHERE LIVE RECOVERY'
Write-Host ('CRM folder : '+$install)
if(-not (Test-Path -LiteralPath $cfgPath)){Write-Host '[FAIL] company-crm.json is missing.' -ForegroundColor Red;Write-Host 'Run CONFIGURE_COMPANY_CRM.bat once.' -ForegroundColor Yellow;exit 3}
try{$cfg=(Clean ([IO.File]::ReadAllText($cfgPath,[Text.Encoding]::UTF8))) | ConvertFrom-Json -ErrorAction Stop}catch{Write-Host ('[FAIL] Could not read CRM connection file: '+$_.Exception.Message) -ForegroundColor Red;exit 3}
if(-not $cfg.baseUrl){Write-Host '[FAIL] LeadSphere Base URL is blank.' -ForegroundColor Red;exit 3}
$secret=''
try{$secret=& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $install 'scripts\read_crm_secret.ps1') $keyPath;$secret=Clean (($secret|Out-String))}catch{}
if(-not $secret){Write-Host '[FAIL] LeadSphere API key cannot be read on this Windows account.' -ForegroundColor Red;Write-Host 'Run CONFIGURE_COMPANY_CRM.bat and keep the same key.' -ForegroundColor Yellow;exit 3}

$base=[Uri]$cfg.baseUrl;$hostName=$base.Host;$port=if($base.Port -gt 0){$base.Port}elseif($base.Scheme -eq 'https'){443}else{80};$scheme=$base.Scheme
Write-Host ('Configured  : '+$cfg.baseUrl)
Write-Host ('Host        : '+$hostName)
Write-Host ('Port        : '+$port)

$ts=Find-TailscaleExe
if($ts){
  try{$tsStatus=& $ts status 2>$null | Out-String;if($LASTEXITCODE -eq 0){Write-Host '[OK] Tailscale is running on this MAIN SERVER.' -ForegroundColor Green}else{Write-Host '[WARN] Tailscale command is installed but status is not healthy.' -ForegroundColor Yellow}}catch{Write-Host '[WARN] Could not read Tailscale status.' -ForegroundColor Yellow}
}else{Write-Host '[WARN] Tailscale executable was not found on this MAIN SERVER.' -ForegroundColor Yellow}

$ips=New-Object System.Collections.Generic.List[string]
try{foreach($a in [Net.Dns]::GetHostAddresses($hostName)){if($a.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork){[void]$ips.Add($a.IPAddressToString)}}}catch{Write-Host ('[WARN] MagicDNS/DNS could not resolve '+$hostName) -ForegroundColor Yellow}
foreach($ip in (Get-TailscalePeerIps $hostName)){[void]$ips.Add($ip)}
$ips=@($ips | Select-Object -Unique)
if($ips.Count){Write-Host ('Resolved IP : '+($ips -join ', '))}else{Write-Host 'Resolved IP : none' -ForegroundColor Yellow}

$candidates=New-Object System.Collections.Generic.List[string];[void]$candidates.Add($cfg.baseUrl.TrimEnd('/'))
foreach($ip in $ips){[void]$candidates.Add(($scheme+'://'+$ip+':'+$port))}
$candidates=@($candidates | Select-Object -Unique)
$headers=@{'Accept'='application/json';'X-Client-ID'=([string]$cfg.clientId);'X-Client-Name'='NUNES AI CRM'}
$authHeader=if($cfg.authHeader){[string]$cfg.authHeader}else{'Authorization'};$authScheme=if($null -ne $cfg.authScheme){[string]$cfg.authScheme}else{'Bearer '};$headers[$authHeader]=$authScheme+$secret
$statusPath=if($cfg.statusPath){[string]$cfg.statusPath}else{'/external-api/v1/status'}
$working='';$sawOpen=$false;$lastHttp=''
foreach($candidate in $candidates){
  $u=[Uri]$candidate;$tcp=Test-TcpQuick $u.Host $port
  if($tcp){Write-Host ('[OK] Port '+$port+' open: '+$candidate) -ForegroundColor Green;$sawOpen=$true}else{Write-Host ('[FAIL] Port '+$port+' closed/unreachable: '+$candidate) -ForegroundColor Red;continue}
  try{$r=Invoke-RestMethod -UseBasicParsing -Uri ($candidate+$statusPath) -Headers $headers -TimeoutSec 12;Write-Host ('[OK] LeadSphere API status responded: '+$candidate) -ForegroundColor Green;$working=$candidate;break}catch{
    $lastHttp=$_.Exception.Message
    $statusCode=$null;try{$statusCode=[int]$_.Exception.Response.StatusCode}catch{}
    if($statusCode -eq 401 -or $statusCode -eq 403){Write-Host ('[FAIL] API key/authentication rejected (HTTP '+$statusCode+').') -ForegroundColor Red;Write-Host 'The network is working. Re-enter the current LeadSphere API key.' -ForegroundColor Yellow;exit 5}
    Write-Host ('[FAIL] API status request failed: '+$lastHttp) -ForegroundColor Red
  }
}

if(-not $working){
  Write-Host ''
  if(-not $ips.Count){Write-Host '[ROOT CAUSE] The LeadSphere Tailscale host is not resolving/visible.' -ForegroundColor Red;Write-Host 'Check that Tailscale is ONLINE on the MAIN SERVER and the PC named nunes-crm-server.' -ForegroundColor Yellow}
  elseif(-not $sawOpen){Write-Host ('[ROOT CAUSE] The LeadSphere PC is visible, but port '+$port+' is not open.') -ForegroundColor Red;Write-Host 'The LeadSphere API/server on nunes-crm-server is most likely STOPPED, or Windows Firewall is blocking port 5000.' -ForegroundColor Yellow;Write-Host 'Start the LeadSphere server/API on that PC, then run this BAT again.' -ForegroundColor Yellow}
  else{Write-Host '[ROOT CAUSE] The server port is open, but the LeadSphere status endpoint is failing.' -ForegroundColor Red;Write-Host ('Last error: '+$lastHttp) -ForegroundColor Yellow}
  Write-Host 'No CRM database or old staff data was changed.' -ForegroundColor Cyan
  exit 4
}

if($working -ne $cfg.baseUrl.TrimEnd('/')){
  $stamp=Get-Date -Format 'yyyyMMdd_HHmmss';$backup=Join-Path $data ('company-crm-before-live-recovery_'+$stamp+'.json');Copy-Item -LiteralPath $cfgPath -Destination $backup -Force
  $cfg.baseUrl=$working
  $utf8=New-Object Text.UTF8Encoding($false);[IO.File]::WriteAllText($cfgPath,($cfg|ConvertTo-Json -Depth 20),$utf8)
  Write-Host ('[RECOVERED] MagicDNS route failed; CRM now uses working Tailscale IP '+$working) -ForegroundColor Green
  Write-Host ('Config backup: '+$backup) -ForegroundColor DarkGray
}

$localPort=8765;$pf=Join-Path $data 'active_port.txt';if(Test-Path -LiteralPath $pf){try{$v=[int](Get-Content -LiteralPath $pf -Raw).Trim();if($v -gt 0){$localPort=$v}}catch{}}
$local='http://127.0.0.1:'+$localPort
try{$null=Invoke-RestMethod -UseBasicParsing -Uri ($local+'/api/health') -TimeoutSec 3}catch{
  Write-Host '[INFO] NUNES AI CRM server is not responding locally. Starting it...' -ForegroundColor Yellow
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c','"'+(Join-Path $install 'START_CRM_SERVER_ONLY.bat')+'"') -WorkingDirectory $install -WindowStyle Hidden
  Start-Sleep -Seconds 4
}
try{
  $test=Invoke-RestMethod -UseBasicParsing -Method Post -Uri ($local+'/api/integrations/company-crm/test') -ContentType 'application/json' -Body '{}' -TimeoutSec 20
  Write-Host '[OK] NUNES CRM -> LeadSphere test passed.' -ForegroundColor Green
  $sync=Invoke-RestMethod -UseBasicParsing -Method Post -Uri ($local+'/api/integrations/company-crm/sync') -ContentType 'application/json' -Body '{"reconciliation":true}' -TimeoutSec 90
  $d=$sync.data;Write-Host ('[OK] Live reconciliation: received '+$d.received+', new '+$d.inserted+', updated '+$d.updated+', unchanged '+$d.duplicates+', failed '+$d.failed) -ForegroundColor Green
}catch{Write-Host ('[WARN] Network/API recovered, but NUNES CRM immediate sync failed: '+$_.Exception.Message) -ForegroundColor Yellow;Write-Host 'The automatic live-sync supervisor will retry.' -ForegroundColor Yellow}

Write-Host ''
Write-Host 'LIVE CRM RECOVERY COMPLETE.' -ForegroundColor Green
Write-Host 'Old leads, staff-entered fields, quotations and history were preserved.' -ForegroundColor Cyan
exit 0
