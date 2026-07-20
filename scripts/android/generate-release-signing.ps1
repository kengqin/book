param(
    [string]$Keytool = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$signingDir = Join-Path $repoRoot '.release-local\android-signing'
$keystorePath = Join-Path $signingDir 'novel-library-release.jks'
$propertiesPath = Join-Path $signingDir 'signing.properties'
$credentialsPath = Join-Path $signingDir 'IMPORTANT-credentials.txt'
$alias = 'novel-library-release'

if (!$Keytool) {
    $keytoolCommand = Get-Command keytool.exe -ErrorAction SilentlyContinue
    if ($keytoolCommand) {
        $Keytool = $keytoolCommand.Source
    } elseif ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\keytool.exe'))) {
        $Keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
    } else {
        $androidStudioKeytool = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr\bin\keytool.exe'
        if (Test-Path $androidStudioKeytool) {
            $Keytool = $androidStudioKeytool
        }
    }
}

if (!$Keytool -or !(Test-Path $Keytool)) {
    throw 'keytool.exe was not found. Install JDK 17 or newer, or pass -Keytool with its full path.'
}

$existingFiles = @($keystorePath, $propertiesPath, $credentialsPath) | Where-Object { Test-Path $_ }
if ($existingFiles.Count -gt 0 -and !$Force) {
    throw "Release signing already exists. Refusing to overwrite it: $($existingFiles -join ', ')"
}

New-Item -ItemType Directory -Path $signingDir -Force | Out-Null

$randomBytes = New-Object byte[] 36
$randomNumberGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $randomNumberGenerator.GetBytes($randomBytes)
} finally {
    $randomNumberGenerator.Dispose()
}
$password = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$passwordEnvironmentName = 'NOVEL_LIBRARY_ANDROID_SIGNING_PASSWORD'
[Environment]::SetEnvironmentVariable($passwordEnvironmentName, $password, 'Process')

try {
    if ($Force -and (Test-Path $keystorePath)) {
        Remove-Item -LiteralPath $keystorePath -Force
    }

    & $Keytool -genkeypair `
        -alias $alias `
        -keyalg RSA `
        -keysize 4096 `
        -sigalg SHA256withRSA `
        -validity 10000 `
        -dname 'CN=Novel Library, OU=Mobile, O=Kengqin, C=CN' `
        -keystore $keystorePath `
        -storetype PKCS12 `
        '-storepass:env' $passwordEnvironmentName `
        '-keypass:env' $passwordEnvironmentName `
        -noprompt
    if ($LASTEXITCODE -ne 0) {
        throw "keytool failed with exit code $LASTEXITCODE"
    }

    $properties = @(
        '# Local Android release signing configuration. Never commit this file.',
        'storeFile=novel-library-release.jks',
        "storePassword=$password",
        "keyAlias=$alias",
        "keyPassword=$password",
        ''
    ) -join [Environment]::NewLine
    [System.IO.File]::WriteAllText($propertiesPath, $properties, [System.Text.UTF8Encoding]::new($false))

    $createdAt = Get-Date -Format 'yyyy-MM-dd HH:mm:ss K'
    $credentials = @(
        'Novel Library Android Release Signing Credentials',
        '=================================',
        "Created at: $createdAt",
        "Keystore: $keystorePath",
        "Key alias: $alias",
        "Keystore password: $password",
        "Private key password: $password",
        '',
        'IMPORTANT: Every future update must use this key. Keep at least two encrypted offline backups of the entire android-signing directory.',
        'Never send this directory through chat, email, or a source repository. If the key is lost, installed users cannot upgrade in place.',
        ''
    ) -join [Environment]::NewLine
    [System.IO.File]::WriteAllText($credentialsPath, $credentials, [System.Text.UTF8Encoding]::new($false))
} finally {
    [Environment]::SetEnvironmentVariable($passwordEnvironmentName, $null, 'Process')
    $password = $null
}

Write-Host "Android release signing generated in: $signingDir"
Write-Host 'The keystore and passwords are locally ignored by Git.'
Write-Host 'Run npm run mobile:android:signing:verify after building a release APK.'
