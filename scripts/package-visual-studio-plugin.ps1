[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }

$projectRoot = Join-Path $Root 'plugins\visual-studio'
$projectFile = Join-Path $projectRoot 'NovelLibrary.VisualStudio.csproj'
$projectXml = [xml](Get-Content -Raw -LiteralPath $projectFile)
$version = [string]$projectXml.Project.PropertyGroup.Version
if (-not $version -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "Visual Studio plugin version is invalid: $version"
}
if (-not $Output) { $Output = Join-Path $Root "plugins\visual-studio\bin\novel-library-visual-studio-$version.vsix" }

$artifact = Join-Path $projectRoot "bin\novel-library-visual-studio-$version.vsix"
if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
  throw "Official Visual Studio VSIX is missing. Build NovelLibrary.VisualStudio.csproj first: $artifact"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($artifact)
try {
  $entries = @($archive.Entries | ForEach-Object FullName)
  $requiredEntries = @(
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'NovelLibrary.VisualStudio.dll',
    'NovelLibrary.VisualStudio.pkgdef',
    'LICENSE',
    'Icon.png',
    'README.md'
  )
  foreach ($entry in $requiredEntries) {
    if ($entries -notcontains $entry) { throw "Official VSIX is missing required entry: $entry" }
  }

  $manifestEntry = $archive.GetEntry('extension.vsixmanifest')
  $manifestReader = [System.IO.StreamReader]::new($manifestEntry.Open())
  try { [xml]$manifest = $manifestReader.ReadToEnd() } finally { $manifestReader.Dispose() }
  $identity = $manifest.PackageManifest.Metadata.Identity
  if ($identity.Id -ne 'NovelLibrary.VisualStudio' -or $identity.Version -ne $version) {
    throw "Unexpected Visual Studio extension identity: $($identity.Id)@$($identity.Version)"
  }

  $pkgdefEntry = $archive.GetEntry('NovelLibrary.VisualStudio.pkgdef')
  $pkgdefReader = [System.IO.StreamReader]::new($pkgdefEntry.Open())
  try { $pkgdef = $pkgdefReader.ReadToEnd() } finally { $pkgdefReader.Dispose() }
  if ($pkgdef -notmatch '\$RootKey\$\\Menus' -or $pkgdef -notmatch 'NovelLibrary\.VisualStudio\.dll') {
    throw 'Visual Studio package registration or command table registration is missing'
  }
} finally {
  $archive.Dispose()
}

$artifactPath = [System.IO.Path]::GetFullPath($artifact)
$outputPath = [System.IO.Path]::GetFullPath($Output)
if ($artifactPath -ne $outputPath) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputPath) | Out-Null
  Copy-Item -LiteralPath $artifactPath -Destination $outputPath -Force
}
Write-Host "Validated official Visual Studio VSIX: $outputPath"
