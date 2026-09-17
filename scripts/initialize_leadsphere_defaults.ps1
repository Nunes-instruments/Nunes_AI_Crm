param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'
$cfgPath = Join-Path $data 'company-crm.json'
$keyPath = Join-Path $data 'company-crm-key.txt'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'leadsphere_defaults.ps1')

New-Item -ItemType Directory -Path $data -Force | Out-Null

function Clean-Text([string]$text) {
  if ($null -eq $text) { return '' }
  $v = $text.Trim()
  if ($v.Length -gt 0 -and [int][char]$v[0] -eq 0xFEFF) { $v = $v.Substring(1).Trim() }
  return $v
}

$existing = $null
if (Test-Path -LiteralPath $cfgPath) {
  try {
    $raw = Clean-Text ([System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8))
    if ($raw) { $existing = $raw | ConvertFrom-Json -ErrorAction Stop }
  } catch {
    if (-not $Quiet) { Write-Host '[WARNING] Existing LeadSphere config is invalid; restoring defaults.' -ForegroundColor Yellow }
    $existing = $null
  }
}

$secretToKeep = ''
if ($existing -and $existing.webhookSecret) { $secretToKeep = [string]$existing.webhookSecret }
$defaults = New-NunesDefaultLeadSphereConfig -WebhookSecret $secretToKeep

# Preserve user customizations. Only supply missing values and always refresh machine-specific fields.
$cfg = [ordered]@{}
foreach ($name in $defaults.Keys) {
  $value = $null
  if ($existing -and $existing.PSObject.Properties.Name -contains $name) { $value = $existing.$name }
  if ($null -eq $value -or ([string]$value).Length -eq 0) { $value = $defaults[$name] }
  $cfg[$name] = $value
}
$cfg.clientId = $defaults.clientId
$cfg.clientName = 'NUNES AI CRM'
$cfg.webhookUrl = $defaults.webhookUrl
if (-not $cfg.webhookSecret) { $cfg.webhookSecret = $defaults.webhookSecret }

[System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 10), $utf8NoBom)

$keyValid = $false
if (Test-Path -LiteralPath $keyPath) {
  try {
    $rawKey = Clean-Text ([System.IO.File]::ReadAllText($keyPath, [System.Text.Encoding]::UTF8))
    if ($rawKey) {
      $null = ConvertTo-SecureString -String $rawKey -ErrorAction Stop
      [System.IO.File]::WriteAllText($keyPath, $rawKey, $utf8NoBom)
      $keyValid = $true
    }
  } catch {
    $keyValid = $false
  }
}

if (-not $keyValid) {
  $defaultKey = Get-NunesDefaultLeadSphereApiKey
  if (-not [string]::IsNullOrWhiteSpace($defaultKey)) {
    $secure = ConvertTo-SecureString -String $defaultKey -AsPlainText -Force
    $encrypted = ConvertFrom-SecureString $secure
    [System.IO.File]::WriteAllText($keyPath, $encrypted.Trim(), $utf8NoBom)
    $keyValid = $true
    if (-not $Quiet) { Write-Host '[OK] LeadSphere API key saved encrypted for this Windows user.' -ForegroundColor Green }
  } elseif (-not $Quiet) {
    Write-Host '[INFO] LeadSphere API key not configured. Run CONFIGURE_COMPANY_CRM.bat when needed.' -ForegroundColor Yellow
  }
} elseif (-not $Quiet) {
  Write-Host '[OK] Existing Windows-encrypted LeadSphere API key retained.' -ForegroundColor Green
}

if (-not $Quiet) {
  Write-Host ('[OK] LeadSphere: ' + $cfg.baseUrl) -ForegroundColor Cyan
  Write-Host ('[OK] Leads API : ' + $cfg.leadsPath) -ForegroundColor Cyan
  Write-Host ('[OK] Webhook   : ' + $cfg.webhookUrl) -ForegroundColor Cyan
  Write-Host 'Run CONFIGURE_COMPANY_CRM.bat whenever you want to change these defaults.' -ForegroundColor Yellow
}
