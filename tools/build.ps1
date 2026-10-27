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

# Build the native worker, TypeScript server and WebUI on Windows x64.
# Prerequisites: run tools\deps\bootstrap.ps1 once and install Node 24.
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Deps = Join-Path $Root ".sandbox\deps"
$V = Get-Content -Raw (Join-Path $Root "tools\deps\versions.json") | ConvertFrom-Json
. (Join-Path $Root "tools\dev\msvc-env.ps1")
Initialize-RtlWindowsPaths $Root

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
  throw "node_modules is missing; run .\tools\deps\bootstrap.ps1 first."
}
$NodeDir = Join-Path $Deps "node-v$($V.nodeVersion)-win-x64"
$NodeExe = Join-Path $NodeDir "node.exe"
if (-not (Test-Path $NodeExe)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw "Node.js 24 was not found on PATH." }
  $NodeExe = $nodeCmd.Source
}
Assert-RtlNode24 $NodeExe
$NodeBin = Split-Path -Parent $NodeExe
$env:PATH = "$NodeBin;$env:PATH"
$Npm = Join-Path $NodeBin "npm.cmd"
if (-not (Test-Path $Npm)) {
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCmd) { throw "npm.cmd was not found." }
  $Npm = $npmCmd.Source
}

$SlangDir = Join-Path $Deps "slang\lib\cmake\slang"
if (-not (Test-Path (Join-Path $SlangDir "slangConfig.cmake"))) {
  $SlangDir = Join-Path $Deps "slang\lib64\cmake\slang"
}
if (-not (Test-Path (Join-Path $SlangDir "slangConfig.cmake"))) {
  throw "slang is not installed; run .\tools\deps\bootstrap.ps1 first."
}

Enter-RtlMsvcEnv
# Enter-VsDevShell can restore PATH from its original developer-shell state.
# Keep the selected Node/npm available to nested npm lifecycle commands.
$env:PATH = "$NodeBin;$env:PATH"
$CC = if ($env:RTL_CC) { $env:RTL_CC } else { "cl" }
$CXX = if ($env:RTL_CXX) { $env:RTL_CXX } else { "cl" }
if (-not (Get-Command $CC -ErrorAction SilentlyContinue) -or
    -not (Get-Command $CXX -ErrorAction SilentlyContinue)) {
  throw "Requested compiler not found: CC=$CC CXX=$CXX"
}
$BuildDir = Join-Path $Root "build\index-worker"
Write-Host "== configure native worker (CC=$CC CXX=$CXX) =="
Invoke-RtlCmake -ProjectRoot $Root -Arguments @(
  '--fresh', '-S', (Join-Path $Root 'native\index-worker'), '-B', $BuildDir, '-G', 'Ninja',
  '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_TRY_COMPILE_CONFIGURATION=Release',
  '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
  "-DCMAKE_C_COMPILER=$CC", "-DCMAKE_CXX_COMPILER=$CXX",
  "-DRTL_DEPS_DIR=$Deps",
  "-DRTL_SLANG_COMMIT=$($V.slangCommit)",
  "-Dslang_DIR=$SlangDir"
)

Write-Host "== build native worker =="
$jobs = if ($env:RTL_BUILD_JOBS) { [int]$env:RTL_BUILD_JOBS } else { 4 }
Invoke-RtlCmake -ProjectRoot $Root -Arguments @('--build', $BuildDir, '--parallel', "$jobs")

Write-Host "== typecheck =="
& $Npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "TypeScript typecheck failed." }

Write-Host "== build TypeScript server and WebUI =="
& $Npm run build
if ($LASTEXITCODE -ne 0) { throw "TypeScript/WebUI build failed." }

foreach ($artifact in @(
  (Join-Path $BuildDir "index-worker.exe"),
  (Join-Path $Root "dist\server\apps\server\src\main.js"),
  (Join-Path $Root "dist\web\index.html")
)) {
  if (-not (Test-Path $artifact)) { throw "missing build artifact: $artifact" }
}
Write-Host "build: PASS"
