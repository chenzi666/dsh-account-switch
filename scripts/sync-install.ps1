<#
.SYNOPSIS
Install dsh-account-switch into a DSH profile's node_modules as a REAL DIRECTORY.

.DESCRIPTION
The target must be a real directory, never a junction.

Measured 2026-10-02: the same package placed as a junction in the profile's
node_modules is never loaded by the Harness - not even its own apply() runs, and
nothing is reported anywhere. Copying the very same files into a real directory
works immediately. Three control probes (real directory / junction / the full
plugin) pinned this down in one restart. The cause sits in dsh-app-boot's
linkedProfileRoots layer; this script does not investigate it, it just guarantees
the deployment shape that provably works.

Trade-off: after editing the source, re-run this script.

KEEP THIS FILE ASCII-ONLY. The host runs Windows PowerShell 5.1, which reads
.ps1 files as ANSI; any non-ASCII character here corrupts the script itself.

.EXAMPLE
powershell -NoProfile -File scripts/sync-install.ps1
#>
[CmdletBinding()]
param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$target = Join-Path $ProfileDir 'node_modules\dsh-account-switch'

if (-not (Test-Path -LiteralPath (Join-Path $Source 'package.json'))) {
  throw "Source does not look like a package (no package.json): $Source"
}
if (-not (Test-Path -LiteralPath (Join-Path $Source 'node_modules\yaml\package.json'))) {
  throw "Source is missing its yaml dependency; run npm install first: $Source"
}

# Remove the old target. A junction must go through rmdir so only the link is
# removed; a real directory needs Remove-Item.
if (Test-Path -LiteralPath $target) {
  $existing = Get-Item -LiteralPath $target -Force
  if ($existing.LinkType -eq 'Junction') {
    & cmd.exe /c rmdir $target | Out-Null
    Write-Host 'Removed old junction'
  }
  else {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host 'Removed old real directory'
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $target 'lib') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $target 'bin') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $target 'node_modules') | Out-Null

Copy-Item -Path (Join-Path $Source 'lib\*') -Destination (Join-Path $target 'lib') -Recurse -Force
Copy-Item -Path (Join-Path $Source 'bin\*') -Destination (Join-Path $target 'bin') -Recurse -Force
Copy-Item -Path (Join-Path $Source 'package.json') -Destination $target -Force
# The manifest declares dsh.bundle.patch -> ./cordis.patch.yml, so that file has
# to travel with the package. Leaving it behind makes the loader mark the whole
# package as faulty ("dsh: failed to read overlay ..."), not merely as incomplete.
Copy-Item -Path (Join-Path $Source 'cordis.patch.yml') -Destination $target -Force
# yaml is the only runtime dependency and must travel with the package: the
# Harness resolution layer does not install dependencies for plugins.
Copy-Item -Path (Join-Path $Source 'node_modules\yaml') -Destination (Join-Path $target 'node_modules\yaml') -Recurse -Force
# zod is what lib/typert.host.js imports. It travels for the same reason: the
# Harness only supplies packages from its own installation closure, and a
# manifest that cannot be imported means the remote namespace never reaches
# the browser - with no error reported anywhere on the host side.
Copy-Item -Path (Join-Path $Source 'node_modules\zod') -Destination (Join-Path $target 'node_modules\zod') -Recurse -Force

$linkType = (Get-Item -LiteralPath $target -Force).LinkType
if ($linkType -eq 'Junction') { throw 'Target is still a junction after sync, which should be impossible' }

Write-Host "Installed to $target (real directory)"
Write-Host ("  lib          : {0} files" -f (Get-ChildItem (Join-Path $target 'lib') -File -Recurse).Count)
Write-Host ("  node_modules : {0}" -f ((Get-ChildItem (Join-Path $target 'node_modules') -Force | Select-Object -ExpandProperty Name) -join ', '))
Write-Host 'Restart the Harness to take effect.'
