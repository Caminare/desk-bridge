<#
.SYNOPSIS
  Publishes the agent and packs the release zip: DeskBridge.Agent.exe plus third-party licenses.

.DESCRIPTION
  CI runs this on every agent change (version 0.0.0-ci) and on agent-vX.Y.Z tags (version X.Y.Z), where
  the zip becomes the GitHub release asset that the relay's Windows Host tab links to. The zip name has
  no version in it, so releases/latest/download/deskbridge-agent-win-x64.zip always resolves.

  The .NET runtime license files come from the runtime packs the publish actually used, so they always
  match the bundled runtime version.

.EXAMPLE
  ./eng/package-release.ps1 -Version 0.1.0
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')]
    [string]$Version,

    [string]$OutputDir = (Join-Path $PSScriptRoot '..\artifacts\release')
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$app = Join-Path $root 'src\DeskBridge.Agent.App'
$zipName = 'deskbridge-agent-win-x64.zip'

$work = Join-Path ([IO.Path]::GetTempPath()) ("deskbridge-release-" + [Guid]::NewGuid().ToString('N'))
$publish = Join-Path $work 'publish'
$stage = Join-Path $work 'stage'
New-Item -ItemType Directory -Path $publish, $stage | Out-Null

try {
    dotnet publish $app -c Release -p:Version=$Version -o $publish --nologo
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE." }

    $exe = Join-Path $publish 'DeskBridge.Agent.exe'
    $productVersion = (Get-Item $exe).VersionInfo.ProductVersion
    # ProductVersion carries InformationalVersion, which may end in +<commit>.
    if (-not ($productVersion -eq $Version -or $productVersion.StartsWith("$Version+"))) {
        throw "Published exe reports version '$productVersion', expected '$Version'."
    }

    # The single-file publish has no deps.json; the build output next to it records the runtime packs used.
    $depsJson = Get-ChildItem (Join-Path $app 'bin\Release') -Recurse -Filter 'DeskBridge.Agent.deps.json' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $depsJson) { throw 'DeskBridge.Agent.deps.json not found under the Release build output.' }
    $libraries = (Get-Content $depsJson.FullName -Raw | ConvertFrom-Json).libraries.PSObject.Properties.Name

    $packages = $env:NUGET_PACKAGES
    if (-not $packages) {
        $line = dotnet nuget locals global-packages --list
        $packages = ($line -replace '^global-packages:\s*', '').Trim()
    }

    function Get-RuntimePackDir([string]$PackId) {
        $entry = $libraries | Where-Object { $_ -like "runtimepack.$PackId/*" } | Select-Object -First 1
        if (-not $entry) { throw "Runtime pack $PackId is not listed in $($depsJson.Name)." }
        $packVersion = $entry.Split('/')[1]
        $dir = Join-Path $packages "$($PackId.ToLowerInvariant())\$packVersion"
        if (-not (Test-Path $dir)) { throw "Runtime pack folder not found: $dir" }
        return $dir
    }

    $netcore = Get-RuntimePackDir 'Microsoft.NETCore.App.Runtime.win-x64'
    $desktop = Get-RuntimePackDir 'Microsoft.WindowsDesktop.App.Runtime.win-x64'

    # Every file is required: a release without its notices must fail, not ship.
    $files = [ordered]@{
        'DeskBridge.Agent.exe'                        = $exe
        'THIRD-PARTY-NOTICES.txt'                     = Join-Path $root 'THIRD-PARTY-NOTICES.txt'
        'licenses\libjpeg-turbo\LICENSE.md'           = Join-Path $root 'third_party\libjpeg-turbo\LICENSE.md'
        'licenses\libjpeg-turbo\README.ijg'           = Join-Path $root 'third_party\libjpeg-turbo\README.ijg'
        'licenses\dotnet\LICENSE.TXT'                 = Join-Path $netcore 'LICENSE.TXT'
        'licenses\dotnet\THIRD-PARTY-NOTICES.TXT'     = Join-Path $netcore 'THIRD-PARTY-NOTICES.TXT'
        'licenses\windowsdesktop\LICENSE'             = Join-Path $desktop 'LICENSE'
        'licenses\Vortice.Windows.txt'                = Join-Path $root 'licenses\Vortice.Windows.txt'
        'licenses\Vortice.Mathematics.txt'            = Join-Path $root 'licenses\Vortice.Mathematics.txt'
        'licenses\SharpGenTools.txt'                  = Join-Path $root 'licenses\SharpGenTools.txt'
        'licenses\CsWin32.txt'                        = Join-Path $root 'licenses\CsWin32.txt'
    }
    foreach ($target in $files.Keys) {
        $source = $files[$target]
        if (-not (Test-Path $source)) { throw "Missing release file: $source" }
        $dest = Join-Path $stage $target
        New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
        Copy-Item $source $dest
    }

    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
    $zip = Join-Path (Resolve-Path $OutputDir) $zipName
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
    Write-Host "Packed $zip (agent $productVersion)"
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
