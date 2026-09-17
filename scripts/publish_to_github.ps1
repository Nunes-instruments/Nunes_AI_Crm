param(
  [ValidateSet('Push','Folder')][string]$Mode='Push',
  [string]$RepoUrl='https://github.com/Nunes-instruments/Nunes_AI_Crm.git',
  [string]$Branch='main'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

$SourceRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
$versionFile = Join-Path $SourceRoot 'VERSION.txt'
if(!(Test-Path -LiteralPath $versionFile)){throw 'VERSION.txt is missing.'}
$version=(Get-Content -LiteralPath $versionFile -Raw).Trim()
foreach($required in @('server.mjs','public\app.js','scripts\update_from_github.ps1','scripts\install_local_server.ps1','.gitignore')){
  if(!(Test-Path -LiteralPath (Join-Path $SourceRoot $required))){throw "Required source file missing: $required"}
}

function Is-SafeSourceFile([string]$Relative){
  $r=$Relative.Replace('\','/')
  $lower=$r.ToLowerInvariant()
  if($lower -eq '.env' -or ($lower.StartsWith('.env.') -and $lower -ne '.env.example')){return $false}
  foreach($prefix in @('.git/','runtime/','logs/')){if($lower.StartsWith($prefix)){return $false}}
  if($lower.StartsWith('data/') -and $lower -ne 'data/readme.txt'){return $false}
  if($lower.StartsWith('backups/') -and $lower -ne 'backups/readme.txt'){return $false}
  if($lower.StartsWith('public/staff-photos/') -and $lower -ne 'public/staff-photos/readme.txt'){return $false}
  if($lower -eq 'config/staff-server.json'){return $false}
  if($lower -match '(^|/)(client\.json|company-crm\.json|company-crm-key\.txt)$'){return $false}
  if($lower -match '(^|/)(credentials[^/]*\.json|client_secret[^/]*\.json|oauth[^/]*\.json|token[^/]*\.json)$'){return $false}
  if($lower -match '\.(sqlite|sqlite-wal|sqlite-shm|db|log|pid|tmp|new)$'){return $false}
  return $true
}

function Copy-SafeSource([string]$Destination){
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $SourceRoot -Force -Recurse -File | ForEach-Object {
    $rel=$_.FullName.Substring($SourceRoot.Length).TrimStart('\')
    if(Is-SafeSourceFile $rel){
      $dest=Join-Path $Destination $rel
      $parent=Split-Path -Parent $dest
      if($parent -and !(Test-Path -LiteralPath $parent)){New-Item -ItemType Directory -Force -Path $parent | Out-Null}
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
  }
}

function Assert-SafeTree([string]$Root){
  $bad=New-Object System.Collections.Generic.List[string]
  Get-ChildItem -LiteralPath $Root -Force -Recurse -File | ForEach-Object {
    $rel=$_.FullName.Substring($Root.Length).TrimStart('\')
    $normalized=$rel.Replace('\','/')

    # A cloned repository necessarily contains .git metadata.  It is not
    # publishable source and must never be evaluated as CRM payload.
    if($normalized -eq '.git' -or $normalized.StartsWith('.git/')){return}

    if(!(Is-SafeSourceFile $rel)){[void]$bad.Add($rel)}
  }
  if($bad.Count -gt 0){throw ('Safety check blocked publish files: '+($bad -join ', '))}
  foreach($required in @('VERSION.txt','server.mjs','public\app.js','scripts\update_from_github.ps1')){
    if(!(Test-Path -LiteralPath (Join-Path $Root $required))){throw "Prepared GitHub source is incomplete: $required"}
  }
}

if($Mode -eq 'Folder'){
  $desktop=[Environment]::GetFolderPath('DesktopDirectory')
  if([string]::IsNullOrWhiteSpace($desktop)){$desktop=[Environment]::GetFolderPath('Desktop')}
  if([string]::IsNullOrWhiteSpace($desktop)){throw 'Windows Desktop folder could not be found.'}
  $out=Join-Path $desktop 'NUNES_AI_CRM_GITHUB_MASTER_UPLOAD'
  if(Test-Path -LiteralPath $out){Remove-Item -LiteralPath $out -Recurse -Force}
  Copy-SafeSource $out
  Assert-SafeTree $out
  $note=@"
NUNES AI CRM GitHub manual upload folder
Version: $version
Repository: $RepoUrl
Branch: $Branch

Upload the CONTENTS of this folder to the ROOT of GitHub main.
Do not upload this parent folder as an extra repository folder.
VERSION.txt and server.mjs must be directly visible at repository root.
"@
  Set-Content -LiteralPath (Join-Path $out 'UPLOAD_THIS_FOLDER_CONTENTS.txt') -Value $note -Encoding UTF8
  Start-Process explorer.exe -ArgumentList ('"'+$out+'"') | Out-Null
  Start-Process 'https://github.com/Nunes-instruments/Nunes_AI_Crm' | Out-Null
  Write-Host "SAFE_UPLOAD_FOLDER=$out" -ForegroundColor Green
  exit 0
}

$git=''
try{$git=(Get-Command git.exe -ErrorAction Stop).Source}catch{}
if([string]::IsNullOrWhiteSpace($git)){
  Write-Host 'Git for Windows is not installed or not in PATH.' -ForegroundColor Yellow
  Write-Host 'Run GITHUB_PUBLISH_MASTER.bat again and choose option 2.' -ForegroundColor Yellow
  exit 2
}

$tempRoot=Join-Path $env:TEMP ('NUNES_AI_CRM_PUBLISH_'+[guid]::NewGuid().ToString('N'))
$repoRoot=Join-Path $tempRoot 'repo'
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
try{
  Write-Host 'Preparing GitHub main safely...' -ForegroundColor Cyan
  & $git clone $RepoUrl $repoRoot
  if($LASTEXITCODE -ne 0){throw 'git clone failed. Sign in to GitHub if Windows asks, then run again.'}
  Push-Location $repoRoot
  try{
    & $git checkout -B $Branch | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Could not prepare main branch.'}

    # Make the repository tree match the sanitized current source while preserving .git history.
    Get-ChildItem -LiteralPath $repoRoot -Force | Where-Object {$_.Name -ne '.git'} | Remove-Item -Recurse -Force
    Copy-SafeSource $repoRoot
    Assert-SafeTree $repoRoot

    # Local identity only; GitHub account authentication still controls the push.
    $name=(& $git config user.name 2>$null)
    if([string]::IsNullOrWhiteSpace(($name -join ''))){& $git config user.name 'NUNES CRM Server' | Out-Null}
    $email=(& $git config user.email 2>$null)
    if([string]::IsNullOrWhiteSpace(($email -join ''))){& $git config user.email 'nunes-crm@users.noreply.github.com' | Out-Null}

    & $git add -A
    if($LASTEXITCODE -ne 0){throw 'git add failed.'}

    # Final staged-file safety gate.
    $staged=@(& $git diff --cached --name-only)
    foreach($f in $staged){
      if(!(Is-SafeSourceFile ([string]$f))){throw "Unsafe file reached Git staging: $f"}
    }

    & $git diff --cached --quiet
    if($LASTEXITCODE -eq 0){
      Write-Host 'GitHub source already matches this version. Nothing new to commit.' -ForegroundColor Green
    }else{
      $message="NUNES AI CRM v$version production update"
      & $git commit -m $message
      if($LASTEXITCODE -ne 0){throw 'git commit failed.'}
    }

    Write-Host 'Pushing main to GitHub...' -ForegroundColor Cyan
    & $git push -u origin $Branch
    if($LASTEXITCODE -ne 0){throw 'git push failed. Complete the GitHub browser/credential sign-in and run again.'}
    Write-Host "SUCCESS: GitHub main now contains NUNES AI CRM v$version" -ForegroundColor Green
  } finally {Pop-Location}
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
