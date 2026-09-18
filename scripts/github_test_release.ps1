param(
  [ValidateSet('TestAndRelease','TestOnly')][string]$Mode='TestAndRelease',
  [string]$RepoUrl='https://github.com/Nunes-instruments/Nunes_AI_Crm.git',
  [string]$Repo='Nunes-instruments/Nunes_AI_Crm',
  [string]$TestBranch='testing',
  [string]$ProdBranch='main'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

$SourceRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
$versionFile=Join-Path $SourceRoot 'VERSION.txt'
if(!(Test-Path -LiteralPath $versionFile)){throw 'VERSION.txt is missing.'}
$version=(Get-Content -LiteralPath $versionFile -Raw).Trim()

function Write-Step([string]$Text){Write-Host "`n== $Text ==" -ForegroundColor Cyan}
function Write-Ok([string]$Text){Write-Host "[OK] $Text" -ForegroundColor Green}
function Write-Warn([string]$Text){Write-Host "[WARN] $Text" -ForegroundColor Yellow}

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
    if($normalized -eq '.git' -or $normalized.StartsWith('.git/')){return}
    if(!(Is-SafeSourceFile $rel)){[void]$bad.Add($rel)}
  }
  if($bad.Count -gt 0){throw ('Safety gate blocked files: '+($bad -join ', '))}
  foreach($required in @('VERSION.txt','server.mjs','public\app.js','scripts\update_from_github.ps1','scripts\install_local_server.ps1')){
    if(!(Test-Path -LiteralPath (Join-Path $Root $required))){throw "Prepared source is incomplete: $required"}
  }
}

function Get-Git(){
  try{return (Get-Command git.exe -ErrorAction Stop).Source}catch{throw 'Git for Windows is not installed or is not in PATH.'}
}
function Get-Node(){
  $installed=Join-Path $env:LOCALAPPDATA 'NunesAI\CRMServer\App\data\node_path.txt'
  if(Test-Path -LiteralPath $installed){
    try{$p=(Get-Content -LiteralPath $installed -Raw).Trim();if($p -and (Test-Path -LiteralPath $p)){return $p}}catch{}
  }
  try{return (Get-Command node.exe -ErrorAction Stop).Source}catch{throw 'Node.js runtime was not found. Run the main CRM setup once first.'}
}
function Invoke-Git([string]$Git,[string[]]$GitArguments,[string]$WorkingDirectory=''){
  # IMPORTANT: Git writes normal progress (for example "Cloning into...") to STDERR.
  # With global $ErrorActionPreference='Stop', Windows PowerShell 5.1 can incorrectly turn
  # that harmless STDERR progress into a terminating NativeCommandError even when Git exits 0.
  # Temporarily relax native-command error handling, capture BOTH streams, and trust only
  # Git's real process exit code. This keeps authentication/browser prompts compatible too.
  if($null -eq $GitArguments -or $GitArguments.Count -eq 0){throw 'Internal release-gate error: no Git arguments were supplied.'}
  if($WorkingDirectory){Push-Location $WorkingDirectory}
  $oldEap=$ErrorActionPreference
  $hasNativePref=$false
  $oldNativePref=$null
  try{
    Write-Host ('git '+($GitArguments -join ' ')) -ForegroundColor DarkGray
    $ErrorActionPreference='Continue'
    try{
      $nativeVar=Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
      if($nativeVar){$hasNativePref=$true;$oldNativePref=$PSNativeCommandUseErrorActionPreference;$PSNativeCommandUseErrorActionPreference=$false}
    }catch{}
    $nativeOutput=@(& $Git @GitArguments 2>&1)
    $exitCode=$LASTEXITCODE
    foreach($line in $nativeOutput){if($null -ne $line){Write-Host ([string]$line)}}
    if($exitCode -ne 0){throw ('git '+($GitArguments -join ' ')+' failed with exit code '+$exitCode)}
  }finally{
    if($hasNativePref){try{$PSNativeCommandUseErrorActionPreference=$oldNativePref}catch{}}
    $ErrorActionPreference=$oldEap
    if($WorkingDirectory){Pop-Location}
  }
}

function Prepare-TestBranch([string]$Git,[string]$RepoRoot){
  Write-Step "Publishing current source to '$TestBranch' (production main is untouched)"
  Invoke-Git $Git @('fetch','origin','--prune') $RepoRoot
  Invoke-Git $Git @('checkout','-B',$TestBranch,"origin/$ProdBranch") $RepoRoot

  Get-ChildItem -LiteralPath $RepoRoot -Force | Where-Object {$_.Name -ne '.git'} | Remove-Item -Recurse -Force
  Copy-SafeSource $RepoRoot
  Assert-SafeTree $RepoRoot

  Push-Location $RepoRoot
  try{
    $name=(& $Git config user.name 2>$null)
    if([string]::IsNullOrWhiteSpace(($name -join ''))){& $Git config user.name 'NUNES CRM Release' | Out-Null}
    $email=(& $Git config user.email 2>$null)
    if([string]::IsNullOrWhiteSpace(($email -join ''))){& $Git config user.email 'nunes-crm@users.noreply.github.com' | Out-Null}
    Invoke-Git $Git @('add','-A')
    $staged=@(& $Git diff --cached --name-only)
    foreach($f in $staged){if(!(Is-SafeSourceFile ([string]$f))){throw "Unsafe file reached Git staging: $f"}}
    & $Git diff --cached --quiet
    if($LASTEXITCODE -ne 0){
      Invoke-Git $Git @('commit','-m',"NUNES AI CRM v$version test candidate")
    }else{Write-Warn 'Testing branch already matches this source; no new commit needed.'}
    $sha=([string]((& $Git rev-parse HEAD | Select-Object -Last 1))).Trim()
    try{Invoke-Git $Git @('push','-u','origin',$TestBranch,'--force-with-lease')}catch{throw 'Could not push the testing branch. Complete GitHub sign-in and run again. '+$_.Exception.Message}
    Write-Ok "Testing branch published at commit $sha"
    return $sha
  }finally{Pop-Location}
}

function Test-GithubBranch([string]$Git,[string]$Node,[string]$TestRoot,[string]$ExpectedSha){
  Write-Step "Cloning '$TestBranch' back from GitHub for isolated testing"
  Invoke-Git $Git @('clone','--branch',$TestBranch,'--single-branch',$RepoUrl,$TestRoot)
  $actual=([string]((& $Git -C $TestRoot rev-parse HEAD | Select-Object -Last 1))).Trim()
  if($actual -ne $ExpectedSha){throw "Remote testing commit changed. Expected $ExpectedSha but received $actual"}
  Assert-SafeTree $TestRoot

  Write-Step 'Running JavaScript syntax validation'
  $files=@(Get-ChildItem -LiteralPath $TestRoot -Recurse -File | Where-Object {$_.Extension -in @('.js','.mjs') -and $_.FullName -notmatch '[\\/]node_modules[\\/]'} )
  foreach($f in $files){
    & $Node '--check' $f.FullName | Out-Null
    if($LASTEXITCODE -ne 0){throw "JavaScript syntax test failed: $($f.FullName.Substring($TestRoot.Length).TrimStart('\'))"}
  }
  Write-Ok "$($files.Count) JavaScript/MJS files passed syntax checks."

  Write-Step 'Starting isolated test CRM with a fresh temporary database'
  $port=18765
  while($port -lt 18776){
    $busy=$false
    try{$c=New-Object Net.Sockets.TcpClient;$ar=$c.BeginConnect('127.0.0.1',$port,$null,$null);$busy=$ar.AsyncWaitHandle.WaitOne(120);$c.Close()}catch{}
    if(!$busy){break};$port++
  }
  if($port -ge 18776){throw 'No isolated test port available (18765-18775).'}

  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$Node
  $psi.Arguments='--no-warnings server.mjs'
  $psi.WorkingDirectory=$TestRoot
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.RedirectStandardOutput=$true
  $psi.RedirectStandardError=$true
  $psi.EnvironmentVariables['CRM_PORT']=[string]$port
  $psi.EnvironmentVariables['CRM_NO_BROWSER']='1'
  $psi.EnvironmentVariables['CRM_GITHUB_AUTO_UPDATE']='false'
  $psi.EnvironmentVariables['CRM_UPDATE_BRANCH']=$TestBranch
  $proc=New-Object System.Diagnostics.Process
  $proc.StartInfo=$psi
  [void]$proc.Start()
  try{
    $health=$null
    for($i=0;$i -lt 40;$i++){
      Start-Sleep -Milliseconds 500
      if($proc.HasExited){break}
      try{$health=Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2;if($health.ok){break}}catch{}
    }
    if(!$health -or !$health.ok){
      $out='';$err='';try{$out=$proc.StandardOutput.ReadToEnd()}catch{};try{$err=$proc.StandardError.ReadToEnd()}catch{}
      throw "Isolated CRM health test failed. $out $err"
    }
    if([string]$health.version -ne [string]$version){throw "Health endpoint version mismatch. Expected $version, got $($health.version)"}
    $homeResponse=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 5
    if($homeResponse.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace([string]$homeResponse.Content)){throw 'CRM home page smoke test failed.'}
    Write-Ok "Isolated CRM started successfully on test port $port; /api/health and / passed."
  }finally{
    if(!$proc.HasExited){try{$proc.Kill()}catch{};try{$proc.WaitForExit(3000)}catch{}}
  }
}

function Wait-GithubAction([string]$CommitSha){
  Write-Step 'Waiting for GitHub Actions validation on the testing branch'
  $headers=@{'User-Agent'='NUNES-AI-CRM-Release-Gate';'Accept'='application/vnd.github+json'}
  $api="https://api.github.com/repos/$Repo/actions/runs?branch=$TestBranch&event=push&per_page=10"
  $deadline=(Get-Date).AddMinutes(4)
  $seen=$false
  while((Get-Date) -lt $deadline){
    try{
      $runs=Invoke-RestMethod -UseBasicParsing -Uri $api -Headers $headers -TimeoutSec 12
      $run=@($runs.workflow_runs | Where-Object {$_.head_sha -eq $CommitSha} | Select-Object -First 1)
      if($run.Count -gt 0){
        $seen=$true;$r=$run[0]
        if($r.status -eq 'completed'){
          if($r.conclusion -eq 'success'){Write-Ok 'GitHub Actions validation passed.';return $true}
          throw "GitHub Actions validation failed with conclusion: $($r.conclusion)"
        }
        Write-Host "GitHub Actions: $($r.status)..." -ForegroundColor DarkGray
      }
    }catch{
      if($_.Exception.Message -like 'GitHub Actions validation failed*'){throw}
      Write-Host 'Waiting for GitHub Actions result...' -ForegroundColor DarkGray
    }
    Start-Sleep -Seconds 5
  }
  if(!$seen){throw 'GitHub Actions did not start within 4 minutes. Production main was NOT changed.'}
  throw 'GitHub Actions did not finish within 4 minutes. Production main was NOT changed.'
}

function Promote-ToMain([string]$Git,[string]$RepoRoot,[string]$TestSha){
  Write-Step "Promoting tested commit to '$ProdBranch'"
  Invoke-Git $Git @('fetch','origin','--prune') $RepoRoot
  $remoteTest=([string]((& $Git -C $RepoRoot rev-parse "origin/$TestBranch" | Select-Object -Last 1))).Trim()
  if($remoteTest -ne $TestSha){throw 'Testing branch changed after validation. Production main was NOT changed.'}
  Invoke-Git $Git @('checkout','-B',$ProdBranch,"origin/$ProdBranch") $RepoRoot
  Push-Location $RepoRoot
  try{
    try{Invoke-Git $Git @('merge','--ff-only',"origin/$TestBranch")}catch{throw 'main changed while testing. Rerun the test-and-release process; production main was NOT changed.'}
    try{Invoke-Git $Git @('push','origin',$ProdBranch)}catch{throw 'Could not push tested code to main. '+$_.Exception.Message}
    $mainSha=([string]((& $Git rev-parse HEAD | Select-Object -Last 1))).Trim()
    if($mainSha -ne $TestSha){throw 'Promoted main SHA does not match the tested SHA.'}
    Write-Ok "Production main now points to the exact tested commit $mainSha"
  }finally{Pop-Location}
}

function Trigger-InstalledServerUpdate(){
  $app=Join-Path $env:LOCALAPPDATA 'NunesAI\CRMServer\App'
  $updater=Join-Path $app 'scripts\update_from_github.ps1'
  if(!(Test-Path -LiteralPath $updater)){Write-Warn 'This PC is not the installed MAIN SERVER. It will update automatically when its 5-minute GitHub check runs.';return}
  Write-Step 'Updating the installed MAIN SERVER from production main now'
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $updater -Repo $Repo -Branch $ProdBranch -InstallRoot $app -Force
  if($LASTEXITCODE -ne 0){throw 'Production code was promoted, but immediate MAIN SERVER update failed. Existing live data was not intentionally replaced. Run UPDATE_FROM_GITHUB_NOW.bat on the server.'}
  Write-Ok 'MAIN SERVER update triggered successfully. Owner and Staff web apps will reload when the server version changes.'
}

$git=Get-Git
$node=Get-Node
$tempRoot=Join-Path $env:TEMP ('NUNES_AI_CRM_RELEASE_'+[guid]::NewGuid().ToString('N'))
$repoRoot=Join-Path $tempRoot 'repo'
$testRoot=Join-Path $tempRoot 'remote-test'
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try{
  Write-Host '====================================================' -ForegroundColor Cyan
  Write-Host '   NUNES AI CRM - TEST BRANCH RELEASE GATE' -ForegroundColor Cyan
  Write-Host '====================================================' -ForegroundColor Cyan
  Write-Host "Version:     $version"
  Write-Host "Repository:  $Repo"
  Write-Host "Test branch: $TestBranch"
  Write-Host "Production:  $ProdBranch"
  Write-Host ''
  Write-Host 'Live CRM database/settings are NOT copied to GitHub or to the test server.' -ForegroundColor Yellow

  Write-Step 'Cloning production main'
  Invoke-Git $git @('clone',$RepoUrl,$repoRoot)
  $testSha=Prepare-TestBranch $git $repoRoot
  Test-GithubBranch $git $node $testRoot $testSha
  Wait-GithubAction $testSha | Out-Null
  Write-Ok "TEST PASSED: v$version commit $testSha"

  if($Mode -eq 'TestOnly'){
    Write-Host "`nTesting branch is ready. Production main was NOT changed." -ForegroundColor Green
    exit 0
  }

  Promote-ToMain $git $repoRoot $testSha
  Trigger-InstalledServerUpdate
  Write-Host "`n====================================================" -ForegroundColor Green
  Write-Host " RELEASE COMPLETE - NUNES AI CRM v$version" -ForegroundColor Green
  Write-Host ' Same tested commit is now on production main.' -ForegroundColor Green
  Write-Host ' MAIN SERVER -> Owner -> Staff update flow is active.' -ForegroundColor Green
  Write-Host '====================================================' -ForegroundColor Green
  exit 0
}catch{
  Write-Host "`nRELEASE STOPPED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Production main was not intentionally changed unless the message above confirms promotion.' -ForegroundColor Yellow
  Write-Host 'Live SQLite data was not copied into the test environment.' -ForegroundColor Yellow
  exit 1
}finally{
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
