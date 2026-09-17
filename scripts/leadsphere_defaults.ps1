# NUNES AI CRM - LeadSphere connection defaults.
# Production API keys are local-only and are never stored in this GitHub source tree.

function Get-NunesDefaultLeadSphereApiKey {
  # Never store the company API key in GitHub. Existing installed encrypted keys are preserved.
  # For a fresh server, run CONFIGURE_COMPANY_CRM.bat or set COMPANY_CRM_API_KEY in the local .env/environment.
  return [string]$env:COMPANY_CRM_API_KEY
}

function Get-NunesTailscaleHost {
  $tsIp = ''
  try {
    $tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($tailscale) {
      $tsIp = ((& $tailscale.Source ip -4 2>$null | Select-Object -First 1) -as [string]).Trim()
    }
  } catch {}
  if (-not $tsIp) {
    try {
      $tsIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' } |
        Select-Object -First 1 -ExpandProperty IPAddress
    } catch {}
  }
  if ($tsIp) { return [string]$tsIp }
  return [string]$env:COMPUTERNAME
}

function New-NunesDefaultLeadSphereConfig {
  param([string]$WebhookSecret = '')

  if (-not $WebhookSecret) {
    $WebhookSecret = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
  }
  $hostName = Get-NunesTailscaleHost
  $computer = ([string]$env:COMPUTERNAME).ToLowerInvariant()
  if (-not $computer) { $computer = 'windows-pc' }

  return [ordered]@{
    baseUrl = $(if ($env:COMPANY_CRM_BASE_URL) { [string]$env:COMPANY_CRM_BASE_URL } else { '' })
    leadsPath = '/external-api/v1/leads'
    authHeader = 'Authorization'
    authScheme = 'Bearer '
    statusPath = '/external-api/v1/status'
    clientId = ('nunes-ai-crm-' + $computer)
    clientName = 'NUNES AI CRM'
    syncIntervalSeconds = 60
    reconciliationMinutes = 5
    reconciliationDays = 7
    pageSize = 500
    overlapMinutes = 5
    timeoutMs = 30000
    webhookSecret = $WebhookSecret
    webhookUrl = ('http://' + $hostName + ':8765/api/integrations/leadsphere/webhook')
  }
}
