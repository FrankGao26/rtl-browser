# Copyright 2026 Frank Gao
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Windows dependency bootstrap for the RTL Browser developer build.
# Run from a PowerShell prompt with network access once; the resulting
# .sandbox/deps directory is a local cache and is never committed.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Deps = Join-Path $Root ".sandbox\deps"
$Evidence = Join-Path $Root ".sandbox\evidence"
$VersionsFile = Join-Path $Root "tools\deps\versions.json"
$V = Get-Content -Raw $VersionsFile | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $Deps, $Evidence, (Join-Path $Root "build") | Out-Null

. (Join-Path $Root "tools\dev\msvc-env.ps1")

function Get-VersionString {
  param([string]$Command)
  try {
    $text = & $Command --version 2>&1 | Select-Object -First 1
    return [string]$text
  } catch {
    throw "Required tool not found or not runnable: $Command"
  }
}

function Download-Verified {
  param([string]$Url, [string]$Destination, [string]$Sha256)
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if (-not (Test-Path $Destination)) {
    Write-Host "download $(Split-Path -Leaf $Destination)"
    $part = "$Destination.part"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $part
    Move-Item -Force $part $Destination
  }
  $actual = (Get-FileHash -Algorithm SHA256 $Destination).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $Destination`nexpected $Sha256`nactual   $actual"
  }
}

$cmakeVersion = Get-VersionString "cmake"
Write-Host "cmake: $cmakeVersion"
if ($cmakeVersion -notmatch '(\d+)\.(\d+)\.(\d+)') {
  throw "Cannot determine CMake version: $cmakeVersion"
}
$cmakeMajor = [int]$Matches[1]
$cmakeMinor = [int]$Matches[2]
if ($cmakeMajor -lt 3 -or ($cmakeMajor -eq 3 -and $cmakeMinor -lt 28)) {
  throw "CMake >= 3.28 is required (found $cmakeVersion)."
}
if (-not (Get-Command ninja -ErrorAction SilentlyContinue)) {
  throw "Ninja is required (install it and add ninja.exe to PATH)."
}
if (-not (Get-Command python -ErrorAction SilentlyContinue) -and
    -not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw "Python 3 is required by the slang CMake build."
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is required."
}

# Use the host Node when it already has the required major version;
# otherwise fetch the pinned Windows archive for reproducible builds.
$NodeExe = $null
$NodeDir = Join-Path $Deps "node-v$($V.nodeVersion)-win-x64"
if (Get-Command node -ErrorAction SilentlyContinue) {
  $hostNode = (Get-Command node).Source
  $hostVersion = (& $hostNode --version) -replace '^v', ''
  if ([int]($hostVersion.Split('.')[0]) -ge 24) {
    $NodeExe = $hostNode
    Write-Host "node: $hostVersion (host)"
  }
}
if (-not $NodeExe) {
  $nodeZip = Join-Path $Deps (Split-Path -Leaf $V.nodeWindowsX64Url)
  Download-Verified $V.nodeWindowsX64Url $nodeZip $V.nodeWindowsX64Sha256
  if (-not (Test-Path (Join-Path $NodeDir "node.exe"))) {
    Expand-Archive -Force -Path $nodeZip -DestinationPath $Deps
  }
  $NodeExe = Join-Path $NodeDir "node.exe"
  Assert-RtlNode24 $NodeExe
  Write-Host "node: $(& $NodeExe --version) (pinned)"
}
$NodeBin = Split-Path -Parent $NodeExe
$env:PATH = "$NodeBin;$env:PATH"
$Npm = Join-Path $NodeBin "npm.cmd"
if (-not (Test-Path $Npm)) {
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCmd) { throw "npm.cmd not found next to Node or on PATH." }
  $Npm = $npmCmd.Source
}

$sqliteZip = Join-Path $Deps (Split-Path -Leaf $V.sqliteUrl)
Download-Verified $V.sqliteUrl $sqliteZip $V.sqliteSha256
$sqliteDir = Join-Path $Deps "sqlite"
if (-not (Test-Path (Join-Path $sqliteDir "sqlite3.c"))) {
  $tmp = Join-Path $Deps "sqlite.tmp"
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $sqliteZip -DestinationPath $tmp
  Remove-Item -Recurse -Force $sqliteDir -ErrorAction SilentlyContinue
  $source = Get-ChildItem -Directory $tmp | Select-Object -First 1
  if (-not $source) { throw "SQLite archive did not contain a source directory." }
  Move-Item $source.FullName $sqliteDir
  Remove-Item -Recurse -Force $tmp
}

$nlohmannDir = Join-Path $Deps "nlohmann"
New-Item -ItemType Directory -Force -Path $nlohmannDir | Out-Null
$jsonHeader = Join-Path $nlohmannDir "json.hpp"
Download-Verified $V.nlohmannJsonUrl $jsonHeader $V.nlohmannJsonSha256
$licenseUrl = "https://raw.githubusercontent.com/nlohmann/json/v$($V.nlohmannJsonVersion)/LICENSE.MIT"
if (-not (Test-Path (Join-Path $nlohmannDir "LICENSE.MIT"))) {
  try { Invoke-WebRequest -UseBasicParsing -Uri $licenseUrl -OutFile (Join-Path $nlohmannDir "LICENSE.MIT") } catch {}
}

$slangSrc = Join-Path $Deps "slang-src"
if (-not (Test-Path (Join-Path $slangSrc ".git"))) {
  if (Test-Path $slangSrc) { Remove-Item -Recurse -Force $slangSrc }
  git init -q $slangSrc
  git -C $slangSrc remote add origin $V.slangRepository
}
git -C $slangSrc cat-file -e "$($V.slangCommit)^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) {
  git -C $slangSrc fetch --depth 1 origin $V.slangCommit
  if ($LASTEXITCODE -ne 0) { throw "git fetch for slang failed." }
}
git -C $slangSrc checkout -q --detach $V.slangCommit
if ($LASTEXITCODE -ne 0) { throw "git checkout for slang failed." }
if ((git -C $slangSrc rev-parse HEAD) -ne $V.slangCommit) {
  throw "slang checkout does not match the pinned commit."
}

$SlangPrefix = Join-Path $Deps "slang"
$SlangCMake = Join-Path $SlangPrefix "lib\cmake\slang\slangConfig.cmake"
$CC = if ($env:RTL_CC) { $env:RTL_CC } else { "cl" }
$CXX = if ($env:RTL_CXX) { $env:RTL_CXX } else { "cl" }
if (-not (Test-Path $SlangCMake)) {
  Enter-RtlMsvcEnv
  if (-not (Get-Command $CC -ErrorAction SilentlyContinue) -or
      -not (Get-Command $CXX -ErrorAction SilentlyContinue)) {
    throw "Requested compiler not found after entering the VS shell: CC=$CC CXX=$CXX"
  }
  $SlangBuild = Join-Path $Root "build\slang-windows"
  $jobs = if ($env:RTL_BUILD_JOBS) { [int]$env:RTL_BUILD_JOBS } else { 4 }
  Write-Host "configure slang (CC=$CC CXX=$CXX)"
  & cmake -S $slangSrc -B $SlangBuild -G Ninja `
    -DCMAKE_BUILD_TYPE=Release `
    "-DCMAKE_INSTALL_PREFIX=$SlangPrefix" `
    -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded `
    -DSLANG_INCLUDE_TESTS=OFF -DSLANG_INCLUDE_TOOLS=OFF `
    -DSLANG_INCLUDE_DOCS=OFF -DSLANG_INCLUDE_PYLIB=OFF `
    -DSLANG_INCLUDE_INSTALL=ON `
    -DSLANG_USE_MIMALLOC=OFF -DSLANG_USE_SYSTEM_FMT=OFF `
    -DSLANG_USE_SYSTEM_BOOST=OFF -DBUILD_SHARED_LIBS=OFF `
    "-DCMAKE_C_COMPILER=$CC" "-DCMAKE_CXX_COMPILER=$CXX"
  if ($LASTEXITCODE -ne 0) { throw "slang configure failed with exit code $LASTEXITCODE" }
  Write-Host "build slang -j$jobs"
  & cmake --build $SlangBuild --target install --parallel $jobs
  if ($LASTEXITCODE -ne 0) { throw "slang build failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path $SlangCMake)) {
    $SlangCMake = Join-Path $SlangPrefix "lib64\cmake\slang\slangConfig.cmake"
  }
  if (-not (Test-Path $SlangCMake)) { throw "slang install did not produce slangConfig.cmake." }
}

$NpmCache = Join-Path $Root ".sandbox\cache\npm"
$NpmConfig = Join-Path $Root ".sandbox\config\npmrc"
New-Item -ItemType Directory -Force -Path $NpmCache, (Split-Path -Parent $NpmConfig) | Out-Null
Write-Host "install npm dependencies"
& $Npm ci --ignore-scripts --no-audit --no-fund --cache $NpmCache --userconfig $NpmConfig
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }

$lock = [ordered]@{
  source = "tools/deps/versions.json"
  node = [ordered]@{ version = $V.nodeVersion; platform = "win-x64"; sha256 = $V.nodeWindowsX64Sha256 }
  sqlite = [ordered]@{ version = $V.sqliteVersion; sha256 = $V.sqliteSha256 }
  nlohmannJson = [ordered]@{ version = $V.nlohmannJsonVersion; sha256 = $V.nlohmannJsonSha256 }
  slang = [ordered]@{ commit = $V.slangCommit; version = $V.slangVersion }
  npmLock = (Get-FileHash -Algorithm SHA256 (Join-Path $Root "package-lock.json")).Hash.ToLowerInvariant()
}
$lockJson = $lock | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $Deps "deps.lock.json"), $lockJson + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "bootstrap complete: $Deps"
