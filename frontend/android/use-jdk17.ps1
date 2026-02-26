param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$GradleArgs
)

$ErrorActionPreference = 'Stop'

# Where we keep the project-local JDK (ignored by git)
$jdkRoot = Join-Path $PSScriptRoot '.jdks'
$jdkHome = Join-Path $jdkRoot 'temurin-17'

function Find-JavaHome([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  if (Test-Path (Join-Path $path 'bin\\java.exe')) { return $path }
  # If the folder is a container, pick first child that looks like a JDK
  $child = Get-ChildItem -Path $path -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'bin\\java.exe') } |
    Select-Object -First 1
  if ($child) { return $child.FullName }

  # Fallback: some archives have deeper nesting; search for bin\java.exe
  $javaExe = Get-ChildItem -Path $path -Recurse -File -Filter 'java.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\\\bin\\\\java\.exe$" } |
    Select-Object -First 1
  if ($javaExe) {
    # JAVA_HOME is the directory above /bin
    return Split-Path -Parent (Split-Path -Parent $javaExe.FullName)
  }
  return $null
}

$javaHome = Find-JavaHome $jdkHome

if (-not $javaHome) {
  New-Item -ItemType Directory -Force -Path $jdkRoot | Out-Null

  $zipPath = Join-Path $env:TEMP ('temurin-jdk17-' + [Guid]::NewGuid().ToString('N') + '.zip')
  $extractRoot = Join-Path $env:TEMP ('temurin-jdk17-' + [Guid]::NewGuid().ToString('N'))

  Write-Host "Downloading Temurin JDK 17..." -ForegroundColor Cyan
  # Official Adoptium API: latest GA JDK 17 for Windows x64 (HotSpot)
  $url = 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk'
  Invoke-WebRequest -Uri $url -OutFile $zipPath

  Write-Host "Extracting..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

  $found = Find-JavaHome $extractRoot
  if (-not $found) {
    throw "Downloaded archive did not contain a usable JDK (no bin\\java.exe found)."
  }

  # Move into our stable location
  if (Test-Path $jdkHome) {
    Remove-Item -Recurse -Force $jdkHome
  }
  New-Item -ItemType Directory -Force -Path $jdkHome | Out-Null

  # If $found is the JDK root, copy its contents; if it's a subfolder, copy that.
  Copy-Item -Recurse -Force (Join-Path $found '*') $jdkHome

  # Cleanup temp
  Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue

  $javaHome = Find-JavaHome $jdkHome
  if (-not $javaHome) {
    throw "JDK 17 install step failed (JAVA_HOME not found after extraction)."
  }
}

# Default to printing versions if no args passed
if (-not $GradleArgs -or $GradleArgs.Count -eq 0) {
  $GradleArgs = @('-v')
}

Write-Host "Using JAVA_HOME=$javaHome" -ForegroundColor Green
$env:JAVA_HOME = $javaHome
$env:Path = "$javaHome\\bin;$env:Path"

# Run Gradle wrapper with the provided args
& (Join-Path $PSScriptRoot 'gradlew.bat') @GradleArgs
