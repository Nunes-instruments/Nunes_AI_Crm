param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$cfgPath = Join-Path $data 'company-crm.json'
$keyPath = Join-Path $data 'company-crm-key.txt'
. (Join-Path $PSScriptRoot 'leadsphere_defaults.ps1')

$existing = $null
if (Test-Path -LiteralPath $cfgPath) {
  try {
    $raw=[System.IO.File]::ReadAllText($cfgPath,[System.Text.Encoding]::UTF8).Trim()
    if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw=$raw.Substring(1).Trim() }
    if ($raw) { $existing=$raw | ConvertFrom-Json }
  } catch {}
}

$existingWebhookSecret = ''
if ($existing -and $existing.webhookSecret) { $existingWebhookSecret=[string]$existing.webhookSecret }
$defaults = New-NunesDefaultLeadSphereConfig -WebhookSecret $existingWebhookSecret

Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ' NUNES AI CRM -> LEADSPHERE CONNECTION' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Default connection is already built in.' -ForegroundColor Green
Write-Host ('Server        : ' + $defaults.baseUrl) -ForegroundColor Yellow
Write-Host ('Leads API     : ' + $defaults.leadsPath) -ForegroundColor Yellow
Write-Host 'API Key       : Built-in default key' -ForegroundColor Yellow
Write-Host 'Sync interval : 60 seconds' -ForegroundColor Yellow
Write-Host ''
$mode=(Read-Host 'Press ENTER to use defaults, or type C to CHANGE settings').Trim().ToUpperInvariant()

$baseUrl = $defaults.baseUrl
$leadsPath = $defaults.leadsPath
$header = $defaults.authHeader
$authScheme = $defaults.authScheme
$syncIntervalSeconds = 20
$reconciliationMinutes = 2
$reconciliationDays = 7
$pageSize = 500
$overlapMinutes = 5
$timeoutMs = 30000
$defaultApiKey = Get-NunesDefaultLeadSphereApiKey
$apiKeyPlain = $defaultApiKey

if ($mode -eq 'C' -or $mode -eq 'CHANGE') {
  Write-Host ''
  Write-Host 'CHANGE MODE - press ENTER on any item to keep its default.' -ForegroundColor Magenta

  $v=(Read-Host ('LeadSphere API Base URL [' + $baseUrl + ']')).Trim(); if ($v) { $baseUrl=$v }
  if ($baseUrl -notmatch '^https?://') { throw 'A valid http:// or https:// CRM API Base URL is required.' }

  $v=(Read-Host ('Leads endpoint path [' + $leadsPath + ']')).Trim(); if ($v) { $leadsPath=$v }
  $v=(Read-Host ('Authentication header [' + $header + ']')).Trim(); if ($v) { $header=$v }
  $v=(Read-Host 'Authentication scheme [Bearer; type NONE for no scheme]').Trim()
  if ($v) { $authScheme=$(if ($v.ToUpperInvariant() -eq 'NONE') { '' } else { $v.TrimEnd() + ' ' }) }

  $replace=(Read-Host 'Change the built-in API key? [y/N]').Trim().ToUpperInvariant()
  if ($replace -eq 'Y' -or $replace -eq 'YES') {
    $secret=Read-Host 'Paste the new LeadSphere API key' -AsSecureString
    if ($secret.Length -lt 8) { throw 'The API key is missing or too short.' }
    $ptr=[IntPtr]::Zero
    try {
      $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
      $apiKeyPlain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
      if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }
  }

  $v=(Read-Host ('Sync interval seconds [' + $syncIntervalSeconds + ']')).Trim(); if ($v -match '^\d+$' -and [int]$v -ge 10) { $syncIntervalSeconds=[int]$v }
  $v=(Read-Host ('Reconciliation minutes [' + $reconciliationMinutes + ']')).Trim(); if ($v -match '^\d+$' -and [int]$v -ge 1) { $reconciliationMinutes=[int]$v }
  $v=(Read-Host ('Reconciliation days [' + $reconciliationDays + ']')).Trim(); if ($v -match '^\d+$' -and [int]$v -ge 1) { $reconciliationDays=[int]$v }
  $v=(Read-Host ('Page size [' + $pageSize + ']')).Trim(); if ($v -match '^\d+$' -and [int]$v -ge 1) { $pageSize=[int]$v }
  $v=(Read-Host ('Overlap minutes [' + $overlapMinutes + ']')).Trim(); if ($v -match '^\d+$' -and [int]$v -ge 0) { $overlapMinutes=[int]$v }
  $v=(Read-Host ('Timeout milliseconds [' + $timeoutMs + ']')).Trim(); if ($v -match '^\d+$' -and [int]$v -ge 1000) { $timeoutMs=[int]$v }
}

$secureToSave = ConvertTo-SecureString -String $apiKeyPlain -AsPlainText -Force
$encrypted = ConvertFrom-SecureString $secureToSave
[System.IO.File]::WriteAllText($keyPath, $encrypted.Trim(), $utf8NoBom)

$hostName = Get-NunesTailscaleHost
$webhookSecret = $existingWebhookSecret
if (-not $webhookSecret) { $webhookSecret = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')) }
$computer = ([string]$env:COMPUTERNAME).ToLowerInvariant()
if (-not $computer) { $computer='windows-pc' }
$webhookUrl='http://' + $hostName + ':8765/api/integrations/leadsphere/webhook'

$cfg=[ordered]@{
  baseUrl=$baseUrl.TrimEnd('/')
  leadsPath=$leadsPath
  authHeader=$header
  authScheme=$authScheme
  statusPath='/external-api/v1/status'
  clientId=('nunes-ai-crm-'+$computer)
  clientName='NUNES AI CRM'
  syncIntervalSeconds=$syncIntervalSeconds
  reconciliationMinutes=$reconciliationMinutes
  reconciliationDays=$reconciliationDays
  pageSize=$pageSize
  overlapMinutes=$overlapMinutes
  timeoutMs=$timeoutMs
  webhookSecret=$webhookSecret
  webhookUrl=$webhookUrl
}
[System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 10), $utf8NoBom)

Write-Host ''
Write-Host '[OK] Connection configuration saved.' -ForegroundColor Green
Write-Host '[OK] API key encrypted for this Windows user.' -ForegroundColor Green
Write-Host ('Webhook URL    : ' + $webhookUrl) -ForegroundColor Cyan
Write-Host ('Webhook Secret : ' + $webhookSecret) -ForegroundColor Yellow

$headers=@{ 'Accept'='application/json'; 'X-Client-ID'=$cfg.clientId; 'X-Client-Name'=$cfg.clientName }
$headers[$cfg.authHeader] = ([string]$cfg.authScheme) + $apiKeyPlain
try {
  Write-Host ''
  Write-Host 'Testing LeadSphere API...' -ForegroundColor Cyan
  $response=Invoke-RestMethod -Method Get -Uri ($cfg.baseUrl+$cfg.statusPath) -Headers $headers -TimeoutSec ([Math]::Max(5,[Math]::Ceiling($timeoutMs/1000)))
  Write-Host '[OK] LEADSPHERE CONNECTED SUCCESSFULLY' -ForegroundColor Green
} catch {
  Write-Host ('[WARNING] Saved, but live connection test failed: ' + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host 'The CRM can still start. Check Tailscale/server/API access and use 0_TEST_LEADSPHERE_CONNECTION.bat.' -ForegroundColor Yellow
} finally {
  $apiKeyPlain=$null
}
