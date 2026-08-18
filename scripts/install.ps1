<#
.SYNOPSIS
    Rashbase Studio installer for Windows.

.DESCRIPTION
    Downloads the matching installer from the latest GitHub release and runs it.

.EXAMPLE
    irm https://raw.githubusercontent.com/native-productions/rashbase-studio/main/scripts/install.ps1 | iex

.EXAMPLE
    .\install.ps1 -Version v0.1.0 -Installer msi
#>
[CmdletBinding()]
param(
    [string]$Repo = 'native-productions/rashbase-studio',
    [string]$Version = 'latest',
    [ValidateSet('exe', 'msi')]
    [string]$Installer = 'exe',
    # Run the installer without its UI. NSIS and MSI take different flags, so
    # this is translated per installer type below.
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

$arch = $env:PROCESSOR_ARCHITECTURE
$assetArch = switch ($arch) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw "Unsupported architecture: $arch" }
}

$pattern = if ($Installer -eq 'msi') { "_${assetArch}_.*\.msi$" } else { "_${assetArch}-setup\.exe$" }

$api = if ($Version -eq 'latest') {
    "https://api.github.com/repos/$Repo/releases/latest"
} else {
    "https://api.github.com/repos/$Repo/releases/tags/$Version"
}

Write-Info "Looking up $Version release of $Repo"
$headers = @{ Accept = 'application/vnd.github+json' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
$release = Invoke-RestMethod -Uri $api -Headers $headers

$asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
if (-not $asset) {
    throw "No $Installer artifact for $assetArch in the $Version release of $Repo"
}

$dest = Join-Path $env:TEMP $asset.name
Write-Info "Downloading $($asset.name)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest

Write-Info "Running the installer"
if ($Installer -eq 'msi') {
    $installArgs = @('/i', "`"$dest`"")
    if ($Silent) { $installArgs += '/quiet' }
    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $installArgs -Wait -PassThru
} elseif ($Silent) {
    # NSIS silent flag.
    $proc = Start-Process -FilePath $dest -ArgumentList '/S' -Wait -PassThru
} else {
    $proc = Start-Process -FilePath $dest -Wait -PassThru
}

Remove-Item $dest -Force -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0) {
    throw "Installer exited with code $($proc.ExitCode)"
}

Write-Info 'Installed. Launch Rashbase Studio from the Start menu.'
