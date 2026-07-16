[CmdletBinding()]
param(
  [string]$Root = '',
  [ValidateSet('', 'All', 'VSCode', 'JetBrains', 'VisualStudio')]
  [string]$Only = '',
  [switch]$SkipBuild,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$artifactRoot = Join-Path $Root '.release-local\ide-plugins'
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$Name, [string]$Status, [string]$Message) {
  $results.Add([pscustomobject]@{ Name = $Name; Status = $Status; Message = $Message })
}

function Invoke-External([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
  if ($WhatIf) {
    Write-Host "WHATIF: $FilePath $($Arguments -join ' ')"
    return
  }
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$FilePath exited with code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function Find-Executable([string[]]$Names) {
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
  }
  return $null
}

function Select-InstallGroup {
  if ($Only) { return $Only }
  Write-Host ''
  Write-Host 'Select the IDE plugin to install:'
  Write-Host '  1. VS Code / Cursor'
  Write-Host '  2. JetBrains IDEs'
  Write-Host '  3. Visual Studio'
  Write-Host '  4. All detected IDEs'
  Write-Host '  0. Cancel'
  switch (Read-Host 'Enter a number') {
    '1' { return 'VSCode' }
    '2' { return 'JetBrains' }
    '3' { return 'VisualStudio' }
    '4' { return 'All' }
    default { Write-Host 'Installation cancelled.'; exit 0 }
  }
}

function Package-VSCode {
  $source = Join-Path $Root 'plugins\vscode'
  $output = Join-Path $artifactRoot 'novel-library-reader-0.4.0.vsix'
  New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
  $npx = Find-Executable @('npx.cmd', 'npx')
  if (-not $npx) { throw 'npx was not found; cannot package the VS Code/Cursor extension' }
  Invoke-External $npx @('--yes', '@vscode/vsce@3.6.0', 'package', '--allow-missing-repository', '--allow-star-activation', '--out', $output) $source
  return $output
}

function Find-JetBrainsPlugin {
  $candidate = Get-ChildItem (Join-Path $Root 'plugins\intellij\build\distributions') -Filter '*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($candidate) { return $candidate.FullName }
  $candidate = Get-ChildItem $artifactRoot -Filter '*intellij*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($candidate) { return $candidate.FullName }
  return $null
}

function Build-JetBrainsPlugin {
  $gradle = Find-Executable @('gradle.bat', 'gradle')
  if (-not $gradle) { throw 'Gradle was not found. Install Gradle or provide a built JetBrains ZIP in plugins/intellij/build/distributions' }
  Invoke-External $gradle @('buildPlugin') (Join-Path $Root 'plugins\intellij')
  return Find-JetBrainsPlugin
}

function Get-JetBrainsExecutables {
  $roots = @(
    (Join-Path $env:LOCALAPPDATA 'JetBrains\Toolbox\apps'),
    (Join-Path $env:ProgramFiles 'JetBrains'),
    (Join-Path ${env:ProgramFiles(x86)} 'JetBrains')
  ) | Where-Object { $_ -and (Test-Path $_) }
  $executables = foreach ($rootPath in $roots) {
    Get-ChildItem $rootPath -Recurse -File -Include idea64.exe,pycharm64.exe,webstorm64.exe,studio64.exe,rider64.exe,clion64.exe,goland64.exe,rubymine64.exe -ErrorAction SilentlyContinue
  }
  $executables = @($executables | Sort-Object FullName -Unique)
  return $executables
}

function Install-JetBrains([string]$PluginPath) {
  $executables = @(Get-JetBrainsExecutables)
  if (-not $executables.Count) { throw 'No JetBrains IDE installation was detected' }
  Write-Host 'Detected JetBrains IDEs:'
  for ($index = 0; $index -lt $executables.Count; $index++) { Write-Host "  $($index + 1). $($executables[$index].BaseName)" }
  Write-Host '  A. All JetBrains IDEs'
  $selection = if ($WhatIf) { 'A' } else { Read-Host 'Enter comma-separated numbers, or A for all' }
  $targets = if ($selection -eq 'A' -or $selection -eq 'a') {
    $executables
  } else {
    @($selection -split ',' | ForEach-Object {
      $number = 0
      if ([int]::TryParse($_.Trim(), [ref]$number) -and $number -ge 1 -and $number -le $executables.Count) { $executables[$number - 1] }
    })
  }
  if (-not $targets.Count) { throw 'No JetBrains IDE was selected' }
  foreach ($executable in $targets) {
    if ($WhatIf) { Write-Host "WHATIF: $($executable.FullName) installPlugins $PluginPath"; continue }
    Start-Process -FilePath $executable.FullName -ArgumentList @('installPlugins', $PluginPath) -Wait -WindowStyle Hidden
  }
  return "$($targets.Count) JetBrains IDE(s)"
}

function Find-VisualStudioInstaller {
  $known = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\VSIXInstaller.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\VSIXInstaller.exe')
  )
  foreach ($path in $known) { if (Test-Path $path) { return $path } }
  return $null
}

function Find-VisualStudioPlugin {
  $candidate = Get-ChildItem (Join-Path $Root 'plugins\visual-studio\bin') -Filter '*.vsix' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($candidate) { return $candidate.FullName }
  $candidate = Get-ChildItem $artifactRoot -Filter '*visual-studio*.vsix' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($candidate) { return $candidate.FullName }
  return $null
}

function Build-VisualStudioPlugin {
  $msbuild = Find-Executable @('msbuild.exe', 'msbuild')
  if (-not $msbuild) { throw 'MSBuild was not found. Run this script from Visual Studio Developer PowerShell' }
  $project = Join-Path $Root 'plugins\visual-studio\NovelLibrary.VisualStudio.csproj'
  Invoke-External $msbuild @($project, '/p:Configuration=Release') $Root
  return Find-VisualStudioPlugin
}

function Install-VSCode([string]$PluginPath) {
  $executables = @('code', 'cursor') | ForEach-Object { Find-Executable @($_, "$_.cmd") } | Where-Object { $_ } | Sort-Object -Unique
  if (-not $executables.Count) { throw 'No VS Code or Cursor command-line tool was detected' }
  Write-Host 'Detected VS Code-compatible IDEs:'
  for ($index = 0; $index -lt $executables.Count; $index++) { Write-Host "  $($index + 1). $($executables[$index])" }
  Write-Host '  A. All'
  $selection = if ($WhatIf) { 'A' } else { Read-Host 'Enter comma-separated numbers, or A for all' }
  $targets = if ($selection -eq 'A' -or $selection -eq 'a') {
    $executables
  } else {
    @($selection -split ',' | ForEach-Object {
      $number = 0
      if ([int]::TryParse($_.Trim(), [ref]$number) -and $number -ge 1 -and $number -le $executables.Count) { $executables[$number - 1] }
    })
  }
  if (-not $targets.Count) { throw 'No VS Code-compatible IDE was selected' }
  foreach ($executable in $targets) { Invoke-External $executable @('--install-extension', $PluginPath, '--force') $Root }
  return "$($targets.Count) VS Code/Cursor CLI(s)"
}

function Install-VisualStudio([string]$PluginPath) {
  $installer = Find-VisualStudioInstaller
  if (-not $installer) { throw 'Visual Studio VSIXInstaller.exe was not found' }
  if ($WhatIf) { Write-Host "WHATIF: $installer /quiet $PluginPath" } else { Start-Process -FilePath $installer -ArgumentList @('/quiet', $PluginPath) -Wait }
  return 'Visual Studio VSIXInstaller'
}

New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
$Only = Select-InstallGroup

if ($Only -in @('All', 'VSCode')) {
  try {
    $plugin = if ($SkipBuild) { Join-Path $artifactRoot 'novel-library-reader-0.4.0.vsix' } else { Package-VSCode }
    if (-not (Test-Path $plugin)) { throw "VS Code VSIX does not exist: $plugin" }
    Add-Result 'VS Code / Cursor' 'installed' (Install-VSCode $plugin)
  } catch { Add-Result 'VS Code / Cursor' 'failed' $_.Exception.Message }
}

if ($Only -in @('All', 'JetBrains')) {
  try {
    $plugin = if ($SkipBuild) { Find-JetBrainsPlugin } else { Build-JetBrainsPlugin }
    if (-not $plugin) { throw 'JetBrains plugin ZIP was not found' }
    Add-Result 'JetBrains' 'installed' (Install-JetBrains $plugin)
  } catch { Add-Result 'JetBrains' 'failed' $_.Exception.Message }
}

if ($Only -in @('All', 'VisualStudio')) {
  try {
    $plugin = if ($SkipBuild) { Find-VisualStudioPlugin } else { Build-VisualStudioPlugin }
    if (-not $plugin) { throw 'Visual Studio VSIX was not found' }
    Add-Result 'Visual Studio' 'installed' (Install-VisualStudio $plugin)
  } catch { Add-Result 'Visual Studio' 'failed' $_.Exception.Message }
}

$results | Format-Table -AutoSize
if ($results.Status -contains 'failed') { exit 1 }
