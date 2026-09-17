param(
  [ValidateSet('Main','Staff')][string]$Mode='Main',
  [string]$TargetPath='',
  [string]$WorkingDirectory='',
  [string]$DisplayName='NUNES AI CRM',
  [string]$Description='NUNES AI CRM',
  [string]$IconPath=''
)
$ErrorActionPreference='Stop'

function Get-DesktopDirectory {
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach($p in @(
    [Environment]::GetFolderPath('DesktopDirectory'),
    [Environment]::GetFolderPath('Desktop'),
    $(if($env:USERPROFILE){Join-Path $env:USERPROFILE 'Desktop'}),
    $(if($env:OneDrive){Join-Path $env:OneDrive 'Desktop'}),
    $(if($env:OneDriveCommercial){Join-Path $env:OneDriveCommercial 'Desktop'})
  )){
    if([string]::IsNullOrWhiteSpace($p)){ continue }
    try{
      $full=[IO.Path]::GetFullPath($p)
      if(!$candidates.Contains($full)){ [void]$candidates.Add($full) }
    }catch{}
  }
  foreach($p in $candidates){
    if(Test-Path -LiteralPath $p -PathType Container){ return $p }
  }
  if($env:USERPROFILE){
    $fallback=Join-Path $env:USERPROFILE 'Desktop'
    New-Item -ItemType Directory -Force -Path $fallback | Out-Null
    return $fallback
  }
  throw 'Windows Desktop folder could not be located.'
}

if($Mode -eq 'Main'){
  $scriptDir=Split-Path -Parent $MyInvocation.MyCommand.Path
  $root=Split-Path -Parent $scriptDir
  if([string]::IsNullOrWhiteSpace($TargetPath)){ $TargetPath=Join-Path $root 'OPEN_NUNES_CRM.bat' }
  if([string]::IsNullOrWhiteSpace($WorkingDirectory)){ $WorkingDirectory=$root }
  if([string]::IsNullOrWhiteSpace($IconPath)){ $IconPath=Join-Path $root 'assets\NUNES_AI_CRM.ico' }
  $DisplayName='NUNES AI CRM - SERVER'
  $Description='NUNES AI CRM - Main Server Console'
}

if(!(Test-Path -LiteralPath $TargetPath -PathType Leaf)){ throw "Desktop app target is missing: $TargetPath" }
if([string]::IsNullOrWhiteSpace($WorkingDirectory)){ $WorkingDirectory=Split-Path -Parent $TargetPath }
$desktop=Get-DesktopDirectory
$safeName=($DisplayName -replace '[\\/:*?"<>|]','').Trim()
if([string]::IsNullOrWhiteSpace($safeName)){ $safeName='NUNES AI CRM' }
$link=Join-Path $desktop ($safeName + '.lnk')

$ws=New-Object -ComObject WScript.Shell
$shortcut=$ws.CreateShortcut($link)
$shortcut.TargetPath=$TargetPath
$shortcut.WorkingDirectory=$WorkingDirectory
$shortcut.Description=$Description
$shortcut.WindowStyle=1
if($IconPath -and (Test-Path -LiteralPath $IconPath -PathType Leaf)){
  $shortcut.IconLocation="$IconPath,0"
}
$shortcut.Save()

# V2.9.7: the server PC is not the owner sales profile. Remove the old ambiguous main shortcut.
if($Mode -eq 'Main'){
  try{
    $legacy=Join-Path $desktop 'NUNES AI CRM.lnk'
    if($legacy -ne $link -and (Test-Path -LiteralPath $legacy)){Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue}
  }catch{}
}

# Make sure Windows did not inherit Hidden/System attributes and request an icon refresh.
try{
  $item=Get-Item -LiteralPath $link -Force
  if($item.Attributes -band [IO.FileAttributes]::Hidden){ $item.Attributes=$item.Attributes -bxor [IO.FileAttributes]::Hidden }
  if($item.Attributes -band [IO.FileAttributes]::System){ $item.Attributes=$item.Attributes -bxor [IO.FileAttributes]::System }
}catch{}
try{
  $ie4u=Join-Path $env:WINDIR 'System32\ie4uinit.exe'
  if(Test-Path -LiteralPath $ie4u){ Start-Process -FilePath $ie4u -ArgumentList '-show' -WindowStyle Hidden -ErrorAction SilentlyContinue }
}catch{}

Write-Host "Desktop icon created: $link" -ForegroundColor Green
Write-Output $link
