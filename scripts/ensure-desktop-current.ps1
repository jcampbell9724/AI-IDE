[CmdletBinding()]
param(
  [switch]$ForceBuild,
  [switch]$SkipBuild,
  [switch]$NoLaunch,
  [int]$WaitForProcessId = 0,
  [switch]$LaunchAfterRefresh,
  [int]$KeepProcessId = 0,
  [switch]$SkipInstalledSync
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($ForceBuild -and $SkipBuild) {
  throw "ForceBuild and SkipBuild cannot be used together."
}

$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$desktopRoot = Join-Path $workspaceRoot "apps\desktop"
$releaseRoot = Join-Path $desktopRoot "release\win-unpacked"
$releaseExe = Join-Path $releaseRoot "Span.exe"
$releaseAsar = Join-Path $releaseRoot "resources\app.asar"
$workspaceMarkerName = "browser-agent-workspace.txt"
$sourceFingerprintName = "browser-agent-source.sha256"
$installCandidates = @(
  (Join-Path $env:LOCALAPPDATA "Programs\Span"),
  (Join-Path $env:LOCALAPPDATA "Programs\Browser Agent"),
  (Join-Path $env:LOCALAPPDATA "Programs\browser-agent")
) | ForEach-Object { [IO.Path]::GetFullPath($_) }

function Get-WorkspaceSourceFingerprint {
  $excludedDirectories = @(
    ".git", ".pnpm-store", ".qa", "node_modules", "release", "dist", "out", "coverage"
  )
  $excludedFiles = @(".env")
  $files = Get-ChildItem -LiteralPath $workspaceRoot -Recurse -File -Force | Where-Object {
    $relativePath = $_.FullName.Substring($workspaceRoot.Length).TrimStart([char[]]"\/")
    $segments = $relativePath -split '[\\/]'
    -not ($segments | Where-Object { $excludedDirectories -contains $_ }) -and
      -not ($excludedFiles -contains $_.Name)
  } | Sort-Object FullName

  $aggregate = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($file in $files) {
      $relativePath = $file.FullName.Substring($workspaceRoot.Length).TrimStart([char[]]"\/").Replace("\", "/")
      $header = [Text.Encoding]::UTF8.GetBytes("$relativePath`0$($file.Length)`0")
      [void]$aggregate.TransformBlock($header, 0, $header.Length, $header, 0)
      $stream = [IO.File]::OpenRead($file.FullName)
      try {
        $buffer = New-Object byte[] 65536
        while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          [void]$aggregate.TransformBlock($buffer, 0, $count, $buffer, 0)
        }
      } finally {
        $stream.Dispose()
      }
    }
    [void]$aggregate.TransformFinalBlock([byte[]]::new(0), 0, 0)
    return [BitConverter]::ToString($aggregate.Hash).Replace("-", "")
  } finally {
    $aggregate.Dispose()
  }
}

function Stop-WorkspaceBrowserAgent {
  $allowedRoots = @($releaseRoot) + $installCandidates
  foreach ($process in Get-Process -Name "Span", "Browser Agent" -ErrorAction SilentlyContinue) {
    if ($KeepProcessId -gt 0 -and $process.Id -eq $KeepProcessId) { continue }
    $processPath = $null
    try { $processPath = $process.Path } catch { continue }
    if (-not $processPath) { continue }
    $fullProcessPath = [IO.Path]::GetFullPath($processPath)
    $inScope = $allowedRoots | Where-Object {
      $fullProcessPath.StartsWith($_ + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($inScope) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 350
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "")
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

$sourceFingerprint = if ($SkipBuild) { $null } else { Get-WorkspaceSourceFingerprint }
$releaseFingerprintFile = Join-Path $releaseRoot "resources\$sourceFingerprintName"
$releaseFingerprint = if (Test-Path -LiteralPath $releaseFingerprintFile) {
  (Get-Content -Raw -LiteralPath $releaseFingerprintFile).Trim()
} else { $null }
$needsBuild = $ForceBuild -or -not (Test-Path -LiteralPath $releaseAsar)
if (-not $needsBuild -and -not $SkipBuild) {
  $needsBuild = $sourceFingerprint -ne $releaseFingerprint
}

if ($needsBuild -and -not $SkipBuild) {
  $pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if (-not $pnpmCommand) { $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue }
  if (-not $pnpmCommand) {
    throw "pnpm is required to rebuild Span after source changes."
  }

  Write-Host "Updating Span from the latest workspace code..."
  Stop-WorkspaceBrowserAgent
  Push-Location $workspaceRoot
  try {
    & $pnpmCommand.Source run build
    if ($LASTEXITCODE -ne 0) { throw "The workspace build failed." }
    & $pnpmCommand.Source --filter "@browser-agent/desktop" run pack:prepared
    if ($LASTEXITCODE -ne 0) { throw "The desktop package assembly failed." }
  } finally {
    Pop-Location
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $releaseFingerprintFile) -Force | Out-Null
  Set-Content -LiteralPath $releaseFingerprintFile -Value $sourceFingerprint -NoNewline
}

if (-not (Test-Path -LiteralPath $releaseExe) -or -not (Test-Path -LiteralPath $releaseAsar)) {
  throw "The ready-to-run Span package is missing."
}

$releaseWorkspaceMarker = Join-Path $releaseRoot "resources\$workspaceMarkerName"
Set-Content -LiteralPath $releaseWorkspaceMarker -Value $workspaceRoot -NoNewline

$installRoot = $installCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$launchExe = $releaseExe
if ($installRoot -and -not $SkipInstalledSync) {
  $resolvedInstallRoot = [IO.Path]::GetFullPath($installRoot)
  if ($installCandidates -notcontains $resolvedInstallRoot) {
    throw "Refusing to synchronize an unexpected install directory."
  }

  $installedAsar = Join-Path $resolvedInstallRoot "resources\app.asar"
  $installedFingerprintFile = Join-Path $resolvedInstallRoot "resources\$sourceFingerprintName"
  $requiresSync = -not (Test-Path -LiteralPath $installedAsar)
  if (-not $requiresSync) {
    $requiresSync = (Get-Sha256 $releaseAsar) -ne (Get-Sha256 $installedAsar)
  }
  if (-not $requiresSync -and (Test-Path -LiteralPath $releaseFingerprintFile)) {
    $installedFingerprint = if (Test-Path -LiteralPath $installedFingerprintFile) {
      (Get-Content -Raw -LiteralPath $installedFingerprintFile).Trim()
    } else { $null }
    $requiresSync = $installedFingerprint -ne (Get-Content -Raw -LiteralPath $releaseFingerprintFile).Trim()
  }

  if ($requiresSync) {
    Write-Host "Synchronizing the installed Span app..."
    Stop-WorkspaceBrowserAgent
    foreach ($sourceItem in Get-ChildItem -LiteralPath $releaseRoot -Force) {
      Copy-Item -LiteralPath $sourceItem.FullName -Destination $resolvedInstallRoot -Recurse -Force
    }
    $releaseHash = Get-Sha256 $releaseAsar
    $installedHash = Get-Sha256 $installedAsar
    if ($releaseHash -ne $installedHash) {
      throw "The installed Span did not match the workspace package after synchronization."
    }
  }
  Copy-Item -LiteralPath $releaseWorkspaceMarker -Destination (Join-Path $resolvedInstallRoot "resources\$workspaceMarkerName") -Force
  if (Test-Path -LiteralPath $releaseFingerprintFile) {
    Copy-Item -LiteralPath $releaseFingerprintFile -Destination (Join-Path $resolvedInstallRoot "resources\$sourceFingerprintName") -Force
  }
  $launchExe = Join-Path $resolvedInstallRoot "Span.exe"
}

if ($WaitForProcessId -gt 0) {
  Wait-Process -Id $WaitForProcessId -ErrorAction SilentlyContinue
}

if ($LaunchAfterRefresh) {
  Start-Process -FilePath $launchExe -ArgumentList "--workspace-refresh-complete" -WorkingDirectory (Split-Path -Parent $launchExe)
} elseif (-not $NoLaunch) {
  Start-Process -FilePath $launchExe -ArgumentList "--workspace-refresh-complete" -WorkingDirectory (Split-Path -Parent $launchExe)
}

Write-Host "Span is current: $launchExe"
