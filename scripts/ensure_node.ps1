param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataDir = Join-Path $Root 'data'
$NodePathFile = Join-Path $DataDir 'node_path.txt'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# NUNES AI CRM V2.6.8 uses one shared portable Node runtime for every CRM update.
# This avoids downloading/installing Node again each time a new CRM ZIP is used.
$NodeVersion = 'v22.23.2'
$archRaw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch -Regex ($archRaw) {
  '^ARM64$' { 'arm64'; break }
  '^(AMD64|IA64)$' { 'x64'; break }
  '^(x86|i[3-6]86)$' { 'x86'; break }
  default { '' }
}

function Test-Node([string]$Exe) {
  try {
    if ([string]::IsNullOrWhiteSpace($Exe)) { return $false }
    if ($Exe -ne 'node' -and !(Test-Path -LiteralPath $Exe)) { return $false }
    $result = & $Exe -e "const [M,m]=process.versions.node.split('.').map(Number);let s=false;try{require('node:sqlite');s=true}catch{};process.stdout.write(((M>22||(M===22&&m>=5))&&s)?'OK':'NO')" 2>$null
    return $result -eq 'OK'
  } catch { return $false }
}

function Save-NodePath([string]$Exe) {
  [System.IO.File]::WriteAllText($NodePathFile, $Exe.Trim(), [System.Text.Encoding]::ASCII)
}

# 1) Fastest path: reuse the runtime already selected for this CRM folder.
if (Test-Path -LiteralPath $NodePathFile) {
  $saved = (Get-Content -LiteralPath $NodePathFile -Raw -ErrorAction SilentlyContinue).Trim()
  if ($saved -and (Test-Node $saved)) {
    if (!$Quiet) { Write-Host "Runtime ready: $saved" -ForegroundColor Green }
    Write-Output $saved
    exit 0
  }
}

if (-not $arch) {
  # Unknown architecture may still work with an already-installed compatible Node.
  if (Get-Command node -ErrorAction SilentlyContinue) {
    if (Test-Node 'node') {
      $resolved = (Get-Command node).Source
      Save-NodePath $resolved
      if (!$Quiet) { Write-Host "Using installed Node.js: $resolved" -ForegroundColor Green }
      Write-Output $resolved
      exit 0
    }
  }
  throw "Unsupported Windows processor architecture: $archRaw"
}

$LocalBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
$SharedRuntimeRoot = Join-Path $LocalBase 'NunesAI\Runtime'
$SharedRuntimeDir = Join-Path $SharedRuntimeRoot "$NodeVersion\$arch"
$SharedNode = Join-Path $SharedRuntimeDir 'node.exe'
$CacheDir = Join-Path $LocalBase 'NunesAI\Cache'
New-Item -ItemType Directory -Force -Path $SharedRuntimeDir,$CacheDir | Out-Null

# 2) Reuse the shared NUNES runtime from any previous/future CRM version.
if (Test-Node $SharedNode) {
  Save-NodePath $SharedNode
  if (!$Quiet) { Write-Host "Shared NUNES runtime ready: $SharedNode" -ForegroundColor Green }
  Write-Output $SharedNode
  exit 0
}

# 3) Reuse a compatible Node already installed on this PC.
if (Get-Command node -ErrorAction SilentlyContinue) {
  if (Test-Node 'node') {
    $resolved = (Get-Command node).Source
    Save-NodePath $resolved
    if (!$Quiet) { Write-Host "Using installed Node.js: $resolved" -ForegroundColor Green }
    Write-Output $resolved
    exit 0
  }
}

# 4) First use on this Windows PC only: download one portable runtime ZIP.
# Direct versioned URL avoids the slower release-index lookup used by older builds.
$hashes = @{
  'x64'   = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
  'x86'   = '725c9e2bdd1c2016b41c995a81f4fa36ce4e2ee565b7455d8f889182727df647'
  'arm64' = 'fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3'
}
$zipName = "node-$NodeVersion-win-$arch.zip"
$url = "https://nodejs.org/dist/$NodeVersion/$zipName"
$zipPath = Join-Path $CacheDir $zipName
$expectedHash = $hashes[$arch]

function Test-CachedZip {
  if (!(Test-Path -LiteralPath $zipPath)) { return $false }
  try {
    return ((Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedHash)
  } catch { return $false }
}

function Download-FileFast([string]$Uri,[string]$Destination) {
  $tmp = "$Destination.download"
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  try {
    # WebClient is considerably quicker than old Windows PowerShell Invoke-WebRequest for large binary files.
    $wc = New-Object System.Net.WebClient
    if ($wc.Proxy) { $wc.Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials }
    $wc.Headers['User-Agent'] = 'NUNES-AI-CRM/2.6.9'
    $wc.DownloadFile($Uri, $tmp)
    $wc.Dispose()
  } catch {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
      Start-BitsTransfer -Source $Uri -Destination $tmp -ErrorAction Stop
    } else {
      Invoke-WebRequest -Uri $Uri -OutFile $tmp -UseBasicParsing -ErrorAction Stop
    }
  }
  Move-Item -LiteralPath $tmp -Destination $Destination -Force
}

if (!$Quiet) {
  Write-Host ''
  Write-Host "Preparing the NUNES portable runtime for Windows $arch..." -ForegroundColor Cyan
  Write-Host 'This download is needed only once on this Windows user profile.' -ForegroundColor DarkGray
}

try {
  if (!(Test-CachedZip)) {
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    Download-FileFast $url $zipPath
  }

  $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    throw 'The downloaded runtime failed its security/integrity check. Please retry with a stable internet connection.'
  }

  # Extract ONLY node.exe instead of thousands of npm files. This makes first setup much faster.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $entry = $archive.Entries | Where-Object { $_.FullName -match '/node\.exe$' } | Select-Object -First 1
    if (!$entry) { throw 'node.exe was not found inside the downloaded runtime package.' }
    $tmpNode = "$SharedNode.new"
    Remove-Item -LiteralPath $tmpNode -Force -ErrorAction SilentlyContinue
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $tmpNode)
    Move-Item -LiteralPath $tmpNode -Destination $SharedNode -Force
  } finally {
    if ($archive) { $archive.Dispose() }
  }

  if (!(Test-Node $SharedNode)) { throw 'The portable Node.js runtime could not start the required SQLite module.' }
  Save-NodePath $SharedNode
  if (!$Quiet) { Write-Host 'Portable runtime is ready.' -ForegroundColor Green }
  Write-Output $SharedNode
  exit 0
} catch {
  Write-Host ''
  Write-Host 'ERROR PREPARING NUNES AI CRM RUNTIME' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ''
  Write-Host 'The CRM itself does not require npm installation. Internet is needed only when this Windows PC has no compatible runtime yet.'
  exit 1
}
