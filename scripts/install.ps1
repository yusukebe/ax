# ax installer for Windows — usage: irm https://ax.yusuke.run/install.ps1 | iex
# Pins the release, verifies SHA-256 against checksums.txt, and only replaces
# an existing ax.exe after verification succeeds.

$ErrorActionPreference = 'Stop'

# pwsh can run on Unix, but this installer only supports Windows.
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    [Console]::Error.WriteLine('ax: this installer is only supported on Windows.')
    exit 1
}

$repo = 'yusukebe/ax'
$asset = 'ax-windows-x64.exe'
$installDir = if ($env:AX_INSTALL_DIR) { $env:AX_INSTALL_DIR } else { Join-Path $HOME '.local\bin' }

# Resolve "latest" to a concrete tag so the binary and checksums.txt are
# guaranteed to come from the same release.
$tag = $env:AX_VERSION
if (-not $tag) {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest"
        $tag = $release.tag_name
    }
    catch {
        [Console]::Error.WriteLine("ax: could not resolve latest release: $_")
        exit 1
    }
}
if ($tag -notmatch '^v') {
    [Console]::Error.WriteLine("ax: could not resolve release tag (got: '$tag')")
    exit 1
}

$downloadBase = if ($env:AX_DOWNLOAD_BASE) { $env:AX_DOWNLOAD_BASE.TrimEnd('/') } else { "https://github.com/$repo/releases/download" }
$base = "$downloadBase/$tag"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())

try {
    New-Item -ItemType Directory -Path $tmp | Out-Null
    $binaryPath = Join-Path $tmp $asset
    $checksumsPath = Join-Path $tmp 'checksums.txt'

    Write-Host "Downloading $asset ($tag) ..."
    Invoke-WebRequest -Uri "$base/$asset" -OutFile $binaryPath
    Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile $checksumsPath

    # Verify SHA-256 before anything touches the install directory.
    $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match ("\s+" + [regex]::Escape($asset) + '$') } | Select-Object -First 1
    if (-not $checksumLine -or $checksumLine -notmatch '^([0-9a-fA-F]{64})\s+') {
        [Console]::Error.WriteLine("ax: $asset not found in checksums.txt for $tag")
        exit 1
    }
    $expected = $Matches[1].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        [Console]::Error.WriteLine("ax: SHA-256 mismatch for $asset ($tag)")
        [Console]::Error.WriteLine("  expected: $expected")
        [Console]::Error.WriteLine("  actual:   $actual")
        [Console]::Error.WriteLine('  refusing to install.')
        exit 1
    }
    Write-Host 'SHA-256 verified.'

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $target = Join-Path $installDir 'ax.exe'
    $staged = Join-Path $installDir ("ax.tmp.$PID.exe")
    Copy-Item -LiteralPath $binaryPath -Destination $staged
    try {
        if (Test-Path -LiteralPath $target) {
            [IO.File]::Replace($staged, $target, $null)
        }
        else {
            [IO.File]::Move($staged, $target)
        }
    }
    finally {
        if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
    }

    Write-Host "Installed ax $tag to $target"
    $pathEntries = $env:PATH -split ';'
    if ($pathEntries -notcontains $installDir) {
        Write-Host ''
        Write-Host "NOTE: $installDir is not in your PATH. Add it to your user or system PATH."
    }

    Write-Host ''
    & $target --version
    if ($LASTEXITCODE -ne 0) { throw 'ax --version failed.' }
    Write-Host "Run 'ax --help' to get started."
}
finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
}
