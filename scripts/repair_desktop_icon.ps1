$ErrorActionPreference='Stop'
$scriptDir=Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRoot=Split-Path -Parent $scriptDir
$localBase=if($env:LOCALAPPDATA){$env:LOCALAPPDATA}else{Join-Path $env:USERPROFILE 'AppData\Local'}
$installedRoot=Join-Path $localBase 'NunesAI\CRMServer\App'
$appRoot=if(Test-Path -LiteralPath (Join-Path $installedRoot 'OPEN_NUNES_CRM.bat') -PathType Leaf){$installedRoot}else{$packageRoot}

$assetDir=Join-Path $appRoot 'assets'
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
$sourceIcon=Join-Path $packageRoot 'assets\NUNES_AI_CRM.ico'
$destIcon=Join-Path $assetDir 'NUNES_AI_CRM.ico'
if(Test-Path -LiteralPath $sourceIcon -PathType Leaf){
  $same=$false
  try{$same=([IO.Path]::GetFullPath($sourceIcon) -eq [IO.Path]::GetFullPath($destIcon))}catch{}
  if(!$same){Copy-Item -LiteralPath $sourceIcon -Destination $destIcon -Force}
}
if(!(Test-Path -LiteralPath $destIcon -PathType Leaf)){throw 'NUNES AI CRM icon file is missing.'}

$helper=Join-Path $packageRoot 'scripts\create_desktop_icon.ps1'
$target=Join-Path $appRoot 'OPEN_NUNES_CRM.bat'
if(!(Test-Path -LiteralPath $target -PathType Leaf)){throw "NUNES AI CRM launcher was not found: $target"}
& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $helper -Mode Main -TargetPath $target -WorkingDirectory $appRoot -IconPath $destIcon
