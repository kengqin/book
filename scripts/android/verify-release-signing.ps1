param(
    [string]$Apk = '',
    [string]$Keytool = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$signingDir = Join-Path $repoRoot '.release-local\android-signing'
$propertiesPath = Join-Path $signingDir 'signing.properties'

if (!(Test-Path $propertiesPath)) {
    throw 'Signing configuration was not found. Run npm run mobile:android:signing:generate first.'
}

$properties = @{}
foreach ($line in Get-Content -LiteralPath $propertiesPath) {
    if ($line -match '^\s*([^#][^=]*)=(.*)$') {
        $properties[$matches[1].Trim()] = $matches[2].Trim()
    }
}

foreach ($requiredName in @('storeFile', 'storePassword', 'keyAlias', 'keyPassword')) {
    if (!$properties[$requiredName]) {
        throw "Signing property is missing: $requiredName"
    }
}

$keystorePath = Join-Path $signingDir $properties.storeFile
if (!(Test-Path $keystorePath)) {
    throw "Keystore was not found: $keystorePath"
}

if (!$Keytool) {
    $keytoolCommand = Get-Command keytool.exe -ErrorAction SilentlyContinue
    if ($keytoolCommand) {
        $Keytool = $keytoolCommand.Source
    } elseif ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\keytool.exe'))) {
        $Keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
    }
}
if (!$Keytool -or !(Test-Path $Keytool)) {
    throw 'keytool.exe was not found.'
}

$passwordEnvironmentName = 'NOVEL_LIBRARY_ANDROID_SIGNING_PASSWORD'
[Environment]::SetEnvironmentVariable($passwordEnvironmentName, $properties.storePassword, 'Process')
$certificatePath = Join-Path ([System.IO.Path]::GetTempPath()) "novel-library-signing-$([guid]::NewGuid().ToString('N')).der"
try {
    & $Keytool -list -v `
        -keystore $keystorePath `
        -alias $properties.keyAlias `
        '-storepass:env' $passwordEnvironmentName
    if ($LASTEXITCODE -ne 0) {
        throw "Keystore verification failed with exit code $LASTEXITCODE"
    }

    & $Keytool -exportcert `
        -keystore $keystorePath `
        -alias $properties.keyAlias `
        -file $certificatePath `
        '-storepass:env' $passwordEnvironmentName
    if ($LASTEXITCODE -ne 0) {
        throw "Certificate export failed with exit code $LASTEXITCODE"
    }
} finally {
    [Environment]::SetEnvironmentVariable($passwordEnvironmentName, $null, 'Process')
}

$certificateStream = $null
$sha256 = $null
try {
    $certificateStream = [System.IO.File]::OpenRead($certificatePath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $keystoreCertificateSha256 = ($sha256.ComputeHash($certificateStream) | ForEach-Object { $_.ToString('x2') }) -join ''
} finally {
    if ($certificateStream) { $certificateStream.Dispose() }
    if ($sha256) { $sha256.Dispose() }
    if (Test-Path $certificatePath) { Remove-Item -LiteralPath $certificatePath -Force }
}

if (!$Apk) {
    $Apk = Join-Path $repoRoot 'apps\mobile\android\app\build\outputs\apk\release\app-release.apk'
}
if (!(Test-Path $Apk)) {
    Write-Host "Keystore is valid. Signed APK does not exist yet: $Apk"
    exit 0
}

$sdkRoot = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$apksigner = Get-ChildItem -Path (Join-Path $sdkRoot 'build-tools') -Filter apksigner.bat -Recurse |
    Sort-Object { [version]$_.Directory.Name } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
if (!$apksigner) {
    throw "apksigner.bat was not found under: $sdkRoot"
}

$apkVerificationOutput = & $apksigner verify --verbose --print-certs $Apk 2>&1
$apkVerificationOutput | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) {
    throw "APK signature verification failed with exit code $LASTEXITCODE"
}

$apkVerificationText = $apkVerificationOutput -join [Environment]::NewLine
foreach ($requiredScheme in @('v1 scheme \(JAR signing\): true', 'v2 scheme \(APK Signature Scheme v2\): true', 'v3 scheme \(APK Signature Scheme v3\): true')) {
    if ($apkVerificationText -notmatch $requiredScheme) {
        throw "APK is missing a required signing scheme: $requiredScheme"
    }
}

$certificateDigestMatch = [regex]::Match(
    $apkVerificationText,
    'Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]+)'
)
if (!$certificateDigestMatch.Success) {
    throw 'Could not read the signer certificate SHA-256 digest from apksigner output.'
}
$apkCertificateSha256 = $certificateDigestMatch.Groups[1].Value.ToLowerInvariant()
if ($apkCertificateSha256 -ne $keystoreCertificateSha256) {
    throw "APK signer does not match the release keystore. APK=$apkCertificateSha256 Keystore=$keystoreCertificateSha256"
}

Write-Host "Android release signing verification passed: $Apk"
Write-Host "Signer SHA-256: $apkCertificateSha256"
