[CmdletBinding()]
param(
  [string]$Account = "",
  [switch]$List,
  [switch]$NoRestart,
  [switch]$DirectTest
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$userConfigDir = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".cyberboss"
$envCandidates = @(
  $env:CYBERBOSS_ENV_FILE,
  (Join-Path $userConfigDir ".env"),
  (Join-Path $projectRoot ".env")
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$envFile = $envCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $envFile) {
  $envFile = Join-Path $userConfigDir ".env"
  [IO.Directory]::CreateDirectory($userConfigDir) | Out-Null
  [IO.File]::WriteAllText($envFile, "", [Text.UTF8Encoding]::new($false))
}

function Get-DotEnvValue([string]$Name) {
  if (-not (Test-Path -LiteralPath $envFile)) {
    return ""
  }
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*$([regex]::Escape($Name))=(.*)$") {
      return $matches[1].Trim()
    }
  }
  return ""
}

$configuredStateDir = Get-DotEnvValue "CYBERBOSS_STATE_DIR"
$stateDir = if ($configuredStateDir) {
  [IO.Path]::GetFullPath($configuredStateDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $projectRoot "..\state"))
}
$accountsDir = Join-Path $stateDir "accounts"
$logFile = Join-Path $stateDir "cyberboss.log"
$pidFile = Join-Path $stateDir "cyberboss.pid"
$weixinConfigFile = Join-Path $stateDir "weixin-config.json"

if (-not (Test-Path -LiteralPath $accountsDir)) {
  throw "Accounts directory not found: $accountsDir"
}

$accounts = @(Get-ChildItem -LiteralPath $accountsDir -Filter "*.json" -File |
  Where-Object { $_.Name -notlike "*.context-tokens.json" } |
  ForEach-Object {
    $record = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
    [pscustomobject]@{
      AccountId = [string]$record.accountId
      UserId = [string]$record.userId
      BaseUrl = [string]$record.baseUrl
      HasToken = -not [string]::IsNullOrWhiteSpace([string]$record.token)
      File = $_.FullName
    }
  })

$currentAccount = Get-DotEnvValue "CYBERBOSS_ACCOUNT_ID"

if ($List -or -not $Account) {
  Write-Host "Saved WeChat accounts:"
  foreach ($entry in $accounts) {
    $marker = if ($entry.AccountId -eq $currentAccount) { "*" } else { " " }
    Write-Host "$marker $($entry.AccountId)  user=$($entry.UserId)  token=$($entry.HasToken)"
  }
  if (-not $Account) {
    Write-Host ""
    Write-Host "Use: .\scripts\switch-weixin-account.ps1 -Account <full-id-or-unique-prefix>"
    exit 0
  }
}

$accountMatches = @($accounts | Where-Object {
  $_.AccountId -eq $Account -or $_.AccountId.StartsWith($Account, [StringComparison]::OrdinalIgnoreCase)
})
if ($accountMatches.Count -eq 0) {
  throw "No saved WeChat account matches: $Account"
}
if ($accountMatches.Count -gt 1) {
  throw "Account prefix is ambiguous: $Account"
}
$selected = $accountMatches[0]
if (-not $selected.HasToken) {
  throw "Saved account has no token; run npm run login first: $($selected.AccountId)"
}
if ([string]::IsNullOrWhiteSpace($selected.UserId)) {
  throw "Saved account has no userId: $($selected.AccountId)"
}

$backupDir = Join-Path $stateDir "backups"
[IO.Directory]::CreateDirectory($backupDir) | Out-Null
$backupFile = Join-Path $backupDir ("env-before-weixin-switch-{0}.bak" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Copy-Item -LiteralPath $envFile -Destination $backupFile

$envText = Get-Content -LiteralPath $envFile -Raw
$replacement = "CYBERBOSS_ACCOUNT_ID=$($selected.AccountId)"
if ($envText -match "(?m)^\s*CYBERBOSS_ACCOUNT_ID=.*$") {
  $accountLinePattern = [regex]::new("(?m)^\s*CYBERBOSS_ACCOUNT_ID=.*$")
  $envText = $accountLinePattern.Replace($envText, $replacement, 1)
} else {
  $envText = $envText.TrimEnd("`r", "`n") + "`r`n" + $replacement + "`r`n"
}
[IO.File]::WriteAllText($envFile, $envText, [Text.UTF8Encoding]::new($false))

Write-Host "Selected account: $($selected.AccountId)"
Write-Host "Target user:     $($selected.UserId)"
Write-Host "Backup:          $backupFile"

if (Test-Path -LiteralPath $weixinConfigFile) {
  $deliveryConfig = Get-Content -LiteralPath $weixinConfigFile -Raw | ConvertFrom-Json
  $minChunkChars = [int]$deliveryConfig.minChunkChars
  if ($minChunkChars -lt 500) {
    Write-Host "Delivery style: conversational segmentation (minChunkChars=$minChunkChars)."
  }
}

if ($NoRestart) {
  Write-Host "Configuration updated; bridge was not restarted."
  exit 0
}

$bridgePattern = "bin[\\/]cyberboss\.js\s+start"
$runningBridges = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "node.exe" -and $_.CommandLine -match $bridgePattern
})
foreach ($bridge in $runningBridges) {
  Write-Host "Stopping bridge PID $($bridge.ProcessId)"
  Stop-Process -Id $bridge.ProcessId
}

Start-Sleep -Seconds 2
$startCommand = "cd /d `"$projectRoot`" && node ./bin/cyberboss.js start >> `"$logFile`" 2>&1"
Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/c $startCommand" -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(15)
$startedPid = 0
do {
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $pidFile) {
    $candidatePid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    if (Get-Process -Id $candidatePid -ErrorAction SilentlyContinue) {
      $startedPid = $candidatePid
      break
    }
  }
} while ((Get-Date) -lt $deadline)

if (-not $startedPid) {
  throw "Bridge did not start within 15 seconds. Check $logFile"
}

$activeBridges = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "node.exe" -and $_.CommandLine -match $bridgePattern
})
if ($activeBridges.Count -ne 1) {
  throw "Expected exactly one bridge, found $($activeBridges.Count)."
}

$accountPattern = "\[cyberboss\] account=$([regex]::Escape($selected.AccountId))"
$accountDeadline = (Get-Date).AddSeconds(15)
$accountConfirmed = $false
do {
  Start-Sleep -Milliseconds 500
  $bootLines = @(Get-Content -LiteralPath $logFile -Tail 80)
  if ($bootLines -match $accountPattern) {
    $accountConfirmed = $true
    break
  }
  if (-not (Get-Process -Id $startedPid -ErrorAction SilentlyContinue)) {
    break
  }
} while ((Get-Date) -lt $accountDeadline)

if (-not $accountConfirmed) {
  throw "Bridge started, but the selected account was not confirmed in the latest log lines."
}

Write-Host "Bridge ready: PID $startedPid (count=1)"
Write-Host "Send one message from the selected WeChat account to refresh its context token."

if ($DirectTest) {
  & node (Join-Path $PSScriptRoot "weixin-direct-test.js") --account $selected.AccountId --state-dir $stateDir
  if ($LASTEXITCODE -ne 0) {
    throw "Direct delivery test failed."
  }
}
