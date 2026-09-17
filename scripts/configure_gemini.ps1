param([switch]$TestOnly)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$envPath=Join-Path $root '.env'
$utf8NoBom=New-Object System.Text.UTF8Encoding($false)

function Read-EnvMap([string]$Path){
  $map=@{}
  if(Test-Path $Path){
    foreach($line in Get-Content $Path){
      $t=$line.Trim(); if(-not $t -or $t.StartsWith('#')){continue}
      $i=$t.IndexOf('='); if($i -le 0){continue}
      $map[$t.Substring(0,$i).Trim()]=$t.Substring($i+1).Trim().Trim('"').Trim("'")
    }
  }
  return $map
}
function Set-EnvValues([hashtable]$Values){
  $lines=@(); if(Test-Path $envPath){$lines=Get-Content $envPath}
  foreach($key in $Values.Keys){$lines=@($lines | Where-Object {$_ -notmatch ('^\s*'+[regex]::Escape($key)+'\s*=')})}
  foreach($key in $Values.Keys){$lines += ($key+'='+[string]$Values[$key])}
  [System.IO.File]::WriteAllLines($envPath,$lines,$utf8NoBom)
}
function Test-Gemini([string]$ApiKey,[string[]]$Models){
  if([string]::IsNullOrWhiteSpace($ApiKey) -or $ApiKey -match 'YOUR_|PASTE|REPLACE|CHANGEME'){
    Write-Host '[ERROR] Gemini API key is not configured.' -ForegroundColor Red
    return $false
  }
  $headers=@{'x-goog-api-key'=$ApiKey;'Accept'='application/json'}
  foreach($model in $Models){
    if([string]::IsNullOrWhiteSpace($model)){continue}
    $uri='https://generativelanguage.googleapis.com/v1beta/models/'+[uri]::EscapeDataString($model)
    try{
      Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 15 | Out-Null
      Write-Host ('[OK] Gemini connection active. Model: '+$model) -ForegroundColor Green
      return $true
    }catch{
      $status=0; try{$status=[int]$_.Exception.Response.StatusCode.value__}catch{}
      if($status -eq 401 -or $status -eq 403 -or ($_.Exception.Message -match 'API.?key|permission|forbidden')){
        Write-Host '[ERROR] Gemini authentication failed. Create/copy the API key from Google AI Studio and run this setup again.' -ForegroundColor Red
        return $false
      }
      if($status -eq 429){Write-Host '[ERROR] Gemini rate limit reached. Wait and test again.' -ForegroundColor Red;return $false}
      if($status -eq 404 -or $status -eq 400){continue}
      Write-Host ('[ERROR] Gemini connection test failed: '+$_.Exception.Message) -ForegroundColor Red
      return $false
    }
  }
  Write-Host '[ERROR] API key responded, but none of the configured Gemini models are available.' -ForegroundColor Red
  return $false
}

Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ' NUNES AI CRM - GEMINI PRODUCT INTELLIGENCE' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ''

if($TestOnly){
  $envMap=Read-EnvMap $envPath
  $models=@($envMap['GEMINI_PRODUCT_MODEL'],$envMap['GEMINI_MODEL'])
  if($envMap['GEMINI_PRODUCT_FALLBACK_MODELS']){$models += $envMap['GEMINI_PRODUCT_FALLBACK_MODELS'].Split(',')}
  if(Test-Gemini $envMap['GEMINI_API_KEY'] $models){exit 0}else{exit 1}
}

Write-Host 'Use a Gemini API key created in Google AI Studio. The key is stored only in this CRM server folder.' -ForegroundColor Yellow
$secret=Read-Host 'Paste Gemini API Key' -AsSecureString
if($secret.Length -lt 12){Write-Host '[ERROR] API key looks too short.' -ForegroundColor Red; exit 1}
$ptr=[IntPtr]::Zero
try{
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim()
  Set-EnvValues @{
    'GEMINI_API_KEY'=$plain
    'GEMINI_MODEL'='gemini-3.8-flash'
    'GEMINI_FALLBACK_MODELS'='gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite'
    'GEMINI_ENABLE_GOOGLE_SEARCH'='true'
    'GEMINI_TIMEOUT_MS'='16000'
    'GEMINI_PRODUCT_MODEL'='gemini-3.8-flash'
    'GEMINI_PRODUCT_FALLBACK_MODELS'='gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite'
    'GEMINI_PRODUCT_ENABLE_GOOGLE_SEARCH'='true'
    'GEMINI_PRODUCT_TIMEOUT_MS'='16000'
    'GEMINI_PRODUCT_MAX_RETRIES'='0'
    'GEMINI_PRODUCT_THINKING_LEVEL'='low'
  }
  Write-Host ''
  $ok=Test-Gemini $plain @('gemini-3.8-flash','gemini-3.6-flash','gemini-3.5-flash','gemini-3.5-flash-lite')
  if($ok){
    Write-Host '[NEXT] Restart NUNES AI CRM using RESTART_CRM.bat.' -ForegroundColor Green
    exit 0
  }
  Write-Host '[ACTION] The key was saved, but the live test failed. Correct the Gemini API key and run CONFIGURE_PRODUCT_INTELLIGENCE.bat again.' -ForegroundColor Yellow
  exit 1
} finally {
  if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
  $plain=$null
}
