[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RuntimePath,
  [Parameter(Mandatory = $true)][string]$TargetRoot
)

$ErrorActionPreference = 'Stop'
$runtime = (Resolve-Path -LiteralPath $RuntimePath).Path
$target = [System.IO.Path]::GetFullPath($TargetRoot)
$runtimeDirectory = Join-Path $target 'runtime\win32-x64'
$targetRuntime = Join-Path $runtimeDirectory 'novel-library-runtime.exe'
[System.IO.Directory]::CreateDirectory($runtimeDirectory) | Out-Null
if ($runtime -ne [System.IO.Path]::GetFullPath($targetRuntime)) {
  Copy-Item -LiteralPath $runtime -Destination $targetRuntime -Force
}
$version = (& $targetRuntime version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw "Runtime version command failed: $version"
}
$hash = (Get-FileHash -LiteralPath $targetRuntime -Algorithm SHA256).Hash.ToLowerInvariant()
$sidecar = "$targetRuntime.sha256"
[System.IO.File]::WriteAllText($sidecar, "$hash  novel-library-runtime.exe`n", [System.Text.UTF8Encoding]::new($false))
$manifest = [ordered]@{
  schemaVersion = 1
  runtimeVersion = $version
  protocolVersion = 2
  minimumProtocolVersion = 1
  artifacts = @([ordered]@{
    platform = 'win32'
    arch = 'x64'
    file = 'runtime/win32-x64/novel-library-runtime.exe'
    sha256 = $hash
  })
}
[System.IO.File]::WriteAllText(
  (Join-Path $target 'runtime-manifest.json'),
  (($manifest | ConvertTo-Json -Depth 5) + "`n"),
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Staged Runtime $version ($hash) in $target"
