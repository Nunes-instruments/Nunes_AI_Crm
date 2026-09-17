@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title NUNES AI CRM - Test LeadSphere Connection
cls
echo ====================================================
echo          TEST LEADSPHERE CONNECTION
echo ====================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\initialize_leadsphere_defaults.ps1" -Quiet >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root='%~dp0'; $cfgp=Join-Path $root 'data\company-crm.json'; $keyp=Join-Path $root 'data\company-crm-key.txt'; if(!(Test-Path $cfgp)){Write-Host '[FAIL] LeadSphere config could not be initialized.' -ForegroundColor Red; exit 2}; if(!(Test-Path $keyp)){Write-Host '[FAIL] LeadSphere API key could not be initialized.' -ForegroundColor Red; exit 3}; & (Join-Path $root 'scripts\repair_leadsphere_connection.ps1') -Quiet; $raw=[IO.File]::ReadAllText($cfgp,[Text.Encoding]::UTF8).Trim(); if($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF){$raw=$raw.Substring(1).Trim()}; $c=$raw|ConvertFrom-Json; $secret=& (Join-Path $root 'scripts\read_crm_secret.ps1') -SecretPath $keyp; $h=@{'Accept'='application/json';'X-Client-ID'=$c.clientId;'X-Client-Name'=$c.clientName}; $h[$c.authHeader]=([string]$c.authScheme)+$secret; try{$r=Invoke-RestMethod -Uri ($c.baseUrl+$c.statusPath) -Headers $h -TimeoutSec 20; Write-Host '[PASS] LeadSphere API Connected' -ForegroundColor Green; Write-Host ('Base URL: '+$c.baseUrl); Write-Host ('Endpoint: '+$c.leadsPath); Write-Host ('Webhook: '+$c.webhookUrl); $r|ConvertTo-Json -Depth 5}catch{Write-Host ('[FAIL] '+$_.Exception.Message) -ForegroundColor Red; exit 1}"
echo.
pause
