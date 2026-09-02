[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'
$archivePath = (Resolve-Path -LiteralPath $Path).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("novel-library-runtime-verify-" + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
$executablePath = Join-Path $temporaryRoot 'novel-library-runtime.exe'
$manifestPath = Join-Path $temporaryRoot 'runtime-manifest.json'
$sidecarPath = Join-Path $temporaryRoot 'novel-library-runtime.exe.sha256'
$runtimeExtracted = $false

function Copy-ZipEntry {
  param(
    [Parameter(Mandatory = $true)]$Entry,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $inputStream = $Entry.Open()
  $outputStream = [System.IO.File]::Create($Destination)
  try {
    $inputStream.CopyTo($outputStream)
  } finally {
    $outputStream.Dispose()
    $inputStream.Dispose()
  }
}

try {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $directEntries = @($archive.Entries | Where-Object {
    $_.FullName -match '(^|/)runtime/.*/novel-library-runtime(?:\.exe)?$' -and $_.Length -gt 0
  })
  $entries = @($directEntries | ForEach-Object FullName)
  if ($directEntries.Count -gt 0) {
    Copy-ZipEntry -Entry $directEntries[0] -Destination $executablePath
    $manifestEntry = @($archive.Entries | Where-Object { $_.FullName -match '(^|/)runtime-manifest\.json$' }) | Select-Object -First 1
    $sidecarEntry = $archive.GetEntry("$($directEntries[0].FullName).sha256")
    if ($manifestEntry) { Copy-ZipEntry -Entry $manifestEntry -Destination $manifestPath }
    if ($sidecarEntry) { Copy-ZipEntry -Entry $sidecarEntry -Destination $sidecarPath }
    $runtimeExtracted = $true
  }
  if (-not $runtimeExtracted) {
    foreach ($jarEntry in @($archive.Entries | Where-Object { $_.FullName -match '\.jar$' })) {
      $stream = $jarEntry.Open()
      try {
        $nested = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Read, $false)
        try {
          $nestedEntries = @($nested.Entries | Where-Object {
            $_.FullName -match '(^|/)runtime/.*/novel-library-runtime(?:\.exe)?$' -and $_.Length -gt 0
          })
          $entries += @($nestedEntries | ForEach-Object { "$($jarEntry.FullName)!/$($_.FullName)" })
          if ($nestedEntries.Count -gt 0) {
            Copy-ZipEntry -Entry $nestedEntries[0] -Destination $executablePath
            $manifestEntry = @($nested.Entries | Where-Object { $_.FullName -match '(^|/)runtime-manifest\.json$' }) | Select-Object -First 1
            $sidecarEntry = $nested.GetEntry("$($nestedEntries[0].FullName).sha256")
            if ($manifestEntry) { Copy-ZipEntry -Entry $manifestEntry -Destination $manifestPath }
            if ($sidecarEntry) { Copy-ZipEntry -Entry $sidecarEntry -Destination $sidecarPath }
            $runtimeExtracted = $true
            break
          }
        } finally {
          $nested.Dispose()
        }
      } finally {
        $stream.Dispose()
      }
    }
  }
    if (-not $runtimeExtracted -or $entries.Count -eq 0) {
      throw "IDE plugin package does not contain a non-empty NovelLibrary Runtime: $archivePath"
    }
  } finally {
    $archive.Dispose()
  }
  $version = (& $executablePath version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "Bundled Runtime version command failed in ${archivePath}: $version"
  }
  if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $sidecarPath)) {
    throw "IDE plugin package is missing runtime-manifest.json or Runtime SHA-256 sidecar: $archivePath"
  }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $actualHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $sidecarHash = ((Get-Content -Raw -LiteralPath $sidecarPath).Trim() -split '\s+')[0].ToLowerInvariant()
  $artifact = @($manifest.artifacts | Where-Object { $_.platform -eq 'win32' -and $_.arch -eq 'x64' }) | Select-Object -First 1
  if ($manifest.runtimeVersion -ne $version -or -not $artifact -or $artifact.sha256.ToLowerInvariant() -ne $actualHash -or $sidecarHash -ne $actualHash) {
    throw "Bundled Runtime manifest or SHA-256 does not match the executable in ${archivePath}"
  }
  $cargoManifest = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/local-runtime/Cargo.toml'
  if (Test-Path -LiteralPath $cargoManifest) {
    $expectedVersion = (Select-String -LiteralPath $cargoManifest -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches.Groups[1].Value
    if ($expectedVersion -and $version -ne $expectedVersion) {
      throw "Bundled Runtime version $version does not match source version $expectedVersion in ${archivePath}"
    }
  }
  Write-Host "Verified bundled Runtime $version in ${archivePath}: $($entries -join ', ')"
} finally {
  [System.IO.Directory]::Delete($temporaryRoot, $true)
}
