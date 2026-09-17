$ErrorActionPreference='Stop'
$ScriptDir=Split-Path -Parent $MyInvocation.MyCommand.Path
$setup=Join-Path $ScriptDir 'setup_staff_pc.ps1'
if(!(Test-Path -LiteralPath $setup)){throw 'Staff setup script is missing.'}
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $setup
exit $LASTEXITCODE
