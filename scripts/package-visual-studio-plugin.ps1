[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not $Output) { $Output = Join-Path $Root 'plugins\visual-studio\bin\novel-library-visual-studio-0.4.0.vsix' }

$projectRoot = Join-Path $Root 'plugins\visual-studio'
$assembly = Join-Path $projectRoot 'bin\Release\net472\NovelLibrary.VisualStudio.dll'
$manifest = Join-Path $projectRoot 'source.extension.vsixmanifest'
$license = Join-Path $projectRoot 'LICENSE'
foreach ($required in @($assembly, $manifest, $license)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "Visual Studio VSIX input is missing: $required"
  }
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("novel-library-vsix-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
  Copy-Item -LiteralPath $assembly -Destination (Join-Path $stage 'NovelLibrary.VisualStudio.dll')
  Copy-Item -LiteralPath $manifest -Destination (Join-Path $stage 'extension.vsixmanifest')
  Copy-Item -LiteralPath $license -Destination (Join-Path $stage 'LICENSE')
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Output) | Out-Null
  if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $Output -CompressionLevel Optimal
  if (-not (Test-Path -LiteralPath $Output -PathType Leaf)) { throw "VSIX was not created: $Output" }
  Write-Host "Created Visual Studio VSIX: $Output"
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
