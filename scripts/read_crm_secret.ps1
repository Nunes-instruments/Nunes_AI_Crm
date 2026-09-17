param([Parameter(Mandatory=$true)][string]$SecretPath)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $SecretPath)) { throw "CRM API key file not found: $SecretPath" }
$raw = [System.IO.File]::ReadAllText($SecretPath, [System.Text.Encoding]::UTF8)
$encrypted = $raw.Trim()
if ($encrypted.Length -gt 0 -and [int][char]$encrypted[0] -eq 0xFEFF) { $encrypted = $encrypted.Substring(1).Trim() }
if (-not $encrypted) { throw 'CRM API key file is empty.' }
try {
  $secure = ConvertTo-SecureString -String $encrypted -ErrorAction Stop
} catch {
  throw "CRM API key could not be decrypted for this Windows user. Run 0_REPAIR_LEADSPHERE_CONNECTION.bat or CONFIGURE_COMPANY_CRM.bat. $($_.Exception.Message)"
}
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
