param([string]$Root = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$vscode = Join-Path $Root 'plugins\vscode'
if (Get-Command code -ErrorAction SilentlyContinue) {
  Write-Host 'Installing VS Code/Cursor integration...'
  Write-Host 'Package the vscode folder as a .vsix before running this installer.'
}
$vsix = Get-ChildItem -Path (Join-Path $Root 'plugins\visual-studio') -Filter '*.vsix' -ErrorAction SilentlyContinue | Select-Object -First 1
$vsInstaller = Get-ChildItem -Path ${env:ProgramFiles(x86)},${env:ProgramFiles} -Filter VSIXInstaller.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($vsix -and $vsInstaller) { Start-Process -FilePath $vsInstaller.FullName -ArgumentList @('/quiet', $vsix.FullName) -Wait }
Write-Host 'IDE integration check complete. JetBrains plugins are installed from the generated ZIP through the IDE plugin manager.'
