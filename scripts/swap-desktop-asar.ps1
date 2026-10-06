<#
.SYNOPSIS
Install (or revert) the patched app.asar for the DeepSeek Harness desktop shell.

.DESCRIPTION
The desktop shell opens the system browser for account sign-in from a permanent
watch over account state, so a plugin cannot stop it. The patched archive adds
"&& !enteredWorkspace" to that condition: the browser is opened automatically
only while the user is still in the welcome flow, and inside the workspace the
account-switch plugin's dialog decides.

The archive is held open by the running application, so it cannot be replaced
while DeepSeek Harness is up. Rather than refusing outright, this script waits
for the app to exit - which avoids the chicken-and-egg problem of needing the app
closed in order to read the instructions for closing it.

KEEP THIS FILE ASCII-ONLY. Windows PowerShell 5.1 reads .ps1 files as ANSI, so a
non-ASCII character here would corrupt the script itself.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/swap-desktop-asar.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/swap-desktop-asar.ps1 -Revert
#>
[CmdletBinding()]
param(
  [string]$Resources = 'D:\Harness\resources',
  [string]$ExpectedSha256 = 'A8937B8B340BD8B6745A43250036CA1CEFE51E3F3CBA5359446E386D596A745F',
  [int]$WaitSeconds = 600,
  [switch]$Revert,
  [switch]$NoWait
)

$ErrorActionPreference = 'Stop'

function Get-HarnessProcesses {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*Harness*' })
}

function Wait-ForExit {
  $running = Get-HarnessProcesses
  if ($running.Count -eq 0) { return }
  if ($NoWait) {
    throw "DeepSeek Harness is still running (pid $(($running.Id) -join ', ')). Close it and run this again, or omit -NoWait to let this script wait for you."
  }
  Write-Host ''
  Write-Host "DeepSeek Harness is running (pid $(($running.Id) -join ', '))."
  Write-Host 'Close the app now - this script continues by itself once it has exited.'
  Write-Host "(waiting up to $WaitSeconds seconds)"
  Write-Host ''
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 1500
    $running = Get-HarnessProcesses
    if ($running.Count -eq 0) {
      Write-Host 'The app has exited; continuing.'
      Start-Sleep -Milliseconds 800
      return
    }
  }
  throw "DeepSeek Harness was still running after $WaitSeconds seconds; nothing was changed."
}

$asar = Join-Path $Resources 'app.asar'
$new = Join-Path $Resources 'app.asar.new'
$bak = Join-Path $Resources 'app.asar.pre-autoswitch.bak'
$swap = Join-Path $Resources 'app.asar.swapping'

if ($Revert) {
  Wait-ForExit
  if (-not (Test-Path -LiteralPath $bak)) { throw "No backup found at $bak" }
  if (Test-Path -LiteralPath $swap) { Remove-Item -LiteralPath $swap -Force }
  Move-Item -LiteralPath $asar -Destination $swap -Force
  try {
    Move-Item -LiteralPath $bak -Destination $asar -Force
  }
  catch {
    Move-Item -LiteralPath $swap -Destination $asar -Force
    throw
  }
  Remove-Item -LiteralPath $swap -Force
  Write-Host ''
  Write-Host "Restored the original archive from $bak"
  exit 0
}

Wait-ForExit

if (-not (Test-Path -LiteralPath $new)) {
  $current = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash
  if ($current -eq $ExpectedSha256) {
    Write-Host ''
    Write-Host 'The patched archive is already installed; nothing to do.'
    exit 0
  }
  throw "No patched archive at $new"
}

$hash = (Get-FileHash -LiteralPath $new -Algorithm SHA256).Hash
Write-Host "patched  : $((Get-Item -LiteralPath $new).Length) bytes  sha256=$hash"
if ($ExpectedSha256 -and $hash -ne $ExpectedSha256) {
  throw 'The patched archive does not match the reviewed build. Refusing to install it.'
}

if (-not (Test-Path -LiteralPath $bak)) {
  Copy-Item -LiteralPath $asar -Destination $bak -Force
  Write-Host "backup   : $bak"
}

if (Test-Path -LiteralPath $swap) { Remove-Item -LiteralPath $swap -Force }
Move-Item -LiteralPath $asar -Destination $swap -Force
try {
  Move-Item -LiteralPath $new -Destination $asar -Force
}
catch {
  Move-Item -LiteralPath $swap -Destination $asar -Force
  throw
}
Remove-Item -LiteralPath $swap -Force

$installed = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash
Write-Host "installed: $((Get-Item -LiteralPath $asar).Length) bytes  sha256=$installed"
if ($installed -ne $hash) { throw 'The installed archive does not match the patched build.' }

Write-Host ''
Write-Host 'Done. Start DeepSeek Harness again.'
Write-Host 'Inside the workspace, "Add account" no longer opens a browser by itself;'
Write-Host 'the dialog buttons decide. Use -Revert to restore the original archive.'
