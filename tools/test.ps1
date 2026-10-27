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

# Cross-platform test subset for native Windows x64.
# POSIX-only security/permission cases live in tests/security.mjs and are
# intentionally not part of this Windows smoke gate.
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Deps = Join-Path $Root ".sandbox\deps"
$V = Get-Content -Raw (Join-Path $Root "tools\deps\versions.json") | ConvertFrom-Json
. (Join-Path $Root "tools\dev\msvc-env.ps1")

$NodeExe = Join-Path (Join-Path $Deps "node-v$($V.nodeVersion)-win-x64") "node.exe"
if (-not (Test-Path $NodeExe)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw "Node.js 24 was not found on PATH." }
  $NodeExe = $nodeCmd.Source
}
Assert-RtlNode24 $NodeExe
$NodeBin = Split-Path -Parent $NodeExe
$env:PATH = "$NodeBin;$env:PATH"
$Npm = Join-Path $NodeBin "npm.cmd"
if (-not (Test-Path $Npm)) { $Npm = (Get-Command npm.cmd).Source }

foreach ($artifact in @(
  (Join-Path $Root "build\index-worker\index-worker.exe"),
  (Join-Path $Root "dist\server\apps\server\src\main.js"),
  (Join-Path $Root "dist\web\index.html")
)) {
  if (-not (Test-Path $artifact)) { throw "missing build artifact: $artifact; run .\tools\build.ps1 first." }
}

Write-Host "== typecheck =="
& $Npm run typecheck
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }

Write-Host "== contracts =="
& $NodeExe "tests\contracts.mjs"
if ($LASTEXITCODE -ne 0) { throw "contracts failed" }

Write-Host "== worker lifecycle =="
& $NodeExe "tests\worker-lifecycle.mjs"
if ($LASTEXITCODE -ne 0) { throw "worker lifecycle failed" }

Write-Host "== Windows long-path snapshot =="
& $NodeExe "tests\windows-long-path.mjs"
if ($LASTEXITCODE -ne 0) { throw "Windows long-path snapshot failed" }

Write-Host "== integration =="
& $NodeExe "tests\integration.mjs"
if ($LASTEXITCODE -ne 0) { throw "integration failed" }

Write-Host "test: PASS"
