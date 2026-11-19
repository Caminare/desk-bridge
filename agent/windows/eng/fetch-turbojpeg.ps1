<#
.SYNOPSIS
  Fetches turbojpeg.dll (libjpeg-turbo 3.2.1, VC x64 build) into third_party/libjpeg-turbo/.

.DESCRIPTION
  Downloads the pinned official release installer into a fresh temp directory, verifies its SHA-256,
  and extracts it with 7z. The installer is NEVER executed. Requires 7z (7-Zip) on PATH or in
  %ProgramFiles%\7-Zip; GitHub's windows-latest runners have it.
#>
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $PSScriptRoot '..\third_party\libjpeg-turbo')
)

$ErrorActionPreference = 'Stop'

$Version = '3.2.1'
$Asset = "libjpeg-turbo-$Version-vc-x64.exe"
$Url = "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/$Version/$Asset"
# Computed from the downloaded asset; matches the digest GitHub reports for the release.
$Sha256 = '1f05bc3ed1585e6b12a8b0c24c8c5f07b1f6d90d01b4b709b331bedc9d6e5838'

$sevenZip = $null
$cmd = Get-Command 7z -ErrorAction SilentlyContinue
if ($cmd) { $sevenZip = $cmd.Source }
else {
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $root) { continue }
        $candidate = Join-Path $root '7-Zip\7z.exe'
        if (Test-Path $candidate) { $sevenZip = $candidate; break }
    }
}
if (-not $sevenZip) { throw '7z was not found. Install 7-Zip (it is preinstalled on GitHub windows-latest) and re-run.' }

$work = Join-Path ([IO.Path]::GetTempPath()) ("turbojpeg-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $installer = Join-Path $work $Asset
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $installer -UseBasicParsing

    $actual = (Get-FileHash -Algorithm SHA256 -Path $installer).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { throw "SHA-256 mismatch for $Asset. Expected $Sha256, got $actual." }

    $extracted = Join-Path $work 'extracted'
    & $sevenZip x -y "-o$extracted" $installer | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7z failed with exit code $LASTEXITCODE." }

    $dll = Get-ChildItem -Path $extracted -Recurse -Filter 'turbojpeg.dll' -File |
        Sort-Object { if ($_.FullName -match '[\\/]bin[\\/]') { 0 } else { 1 } } |
        Select-Object -First 1
    if (-not $dll) { throw "turbojpeg.dll is not in $Asset." }

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item -Path $dll.FullName -Destination (Join-Path $Destination 'turbojpeg.dll') -Force

    foreach ($name in 'LICENSE.md', 'README.ijg') {
        $lic = Get-ChildItem -Path $extracted -Recurse -Filter $name -File | Select-Object -First 1
        if ($lic) { Copy-Item -Path $lic.FullName -Destination (Join-Path $Destination $name) -Force }
        else { Write-Warning "$name was not found in the archive; add it to $Destination before distributing." }
    }
    Write-Host "turbojpeg.dll $Version installed to $((Resolve-Path $Destination).Path)"
}
finally {
    Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
}
