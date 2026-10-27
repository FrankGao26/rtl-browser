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

# Load the x64 MSVC environment into the current PowerShell process.
# Requires Visual Studio Build Tools with the C++ workload.

function Enter-RtlMsvcEnv {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe not found. Install Visual Studio 2022/2026 Build Tools with the C++ x64 workload."
  }
  $install = (& $vswhere -latest -products '*' -property installationPath | Select-Object -First 1)
  if (-not $install) {
    throw "No Visual Studio installation with the C++ x64 workload was found."
  }
  $devShell = Join-Path $install "Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
  if (-not (Test-Path $devShell)) {
    throw "Visual Studio Developer Shell module not found: $devShell"
  }
  Import-Module $devShell
  Enter-VsDevShell -VsInstallPath $install -SkipAutomaticLocation -DevCmdArguments "-arch=x64 -host_arch=x64"
  if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "cl.exe is still unavailable after entering the Visual Studio developer shell."
  }
  $clPath = (Get-Command cl.exe -ErrorAction Stop).Source
  $version = (Get-Item -LiteralPath $clPath).VersionInfo.FileVersion
  Write-Host "MSVC: $version"

  $compiler = if ($env:RTL_CXX) { $env:RTL_CXX } else { "cl" }
  if ($compiler -match '(?i)(^|[\\/])cl(?:\.exe)?$') {
    if ($version -notmatch '^\d+\.\d+' -or [version]$Matches[0] -lt [version]'19.50') {
      throw "slang 12 requires MSVC toolset >= 14.50 (cl >= 19.50). Install VS 2026 C++ Build Tools or select clang-cl >= 17."
    }
  } elseif ($compiler -match '(?i)(^|[\\/])clang-cl(?:\.exe)?$') {
    $clangVersion = & $compiler --version
    if ($LASTEXITCODE -ne 0 -or ($clangVersion -join ' ') -notmatch 'clang version (\d+)' -or [int]$Matches[1] -lt 17) {
      throw "slang 12 requires clang-cl >= 17, with the Visual Studio SDK and STL."
    }
  }

  # VS can ship CMake / Ninja without installing either into the system PATH.
  foreach ($relative in @(
    'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin',
    'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja'
  )) {
    $toolDir = Join-Path $install $relative
    if (Test-Path -LiteralPath $toolDir) { $env:PATH = "$toolDir;$env:PATH" }
  }
}

# Changes apply only to this PowerShell process and its children.
function Initialize-RtlWindowsPaths {
  param([string]$ProjectRoot)
  $private = Join-Path $ProjectRoot '.sandbox'
  foreach ($relative in @('tmp', 'cache\npm', 'cache\node', 'config')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $private $relative) | Out-Null
  }
  $env:TEMP = Join-Path $private 'tmp'
  $env:TMP = $env:TEMP
  $env:TMPDIR = $env:TEMP
  $env:NPM_CONFIG_CACHE = Join-Path $private 'cache\npm'
  $env:NPM_CONFIG_USERCONFIG = Join-Path $private 'config\npmrc'
  $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  $env:NODE_COMPILE_CACHE = Join-Path $private 'cache\node'
  if (-not (Test-Path -LiteralPath $env:NPM_CONFIG_USERCONFIG)) {
    [System.IO.File]::WriteAllText($env:NPM_CONFIG_USERCONFIG, '')
  }
}

function Invoke-RtlCmake {
  param([string]$ProjectRoot, [string[]]$Arguments)
  $cmakeExe = (Get-Command cmake -CommandType Application -ErrorAction Stop).Source
  $savedTemp = $env:TEMP
  $savedTmp = $env:TMP
  $savedTmpdir = $env:TMPDIR
  $savedPreference = $ErrorActionPreference
  Push-Location -LiteralPath $ProjectRoot
  try {
    # MSVC's linker can misdecode a non-ASCII absolute TEMP. Its current
    # working directory (including nested CMake build dirs) is project-private.
    $env:TEMP = '.'
    $env:TMP = '.'
    $env:TMPDIR = '.'
    $ErrorActionPreference = 'Continue'
    & $cmakeExe @Arguments
    $cmakeExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedPreference
    $env:TEMP = $savedTemp
    $env:TMP = $savedTmp
    $env:TMPDIR = $savedTmpdir
    Pop-Location
  }
  if ($cmakeExit -ne 0) { throw "CMake failed with exit code $cmakeExit" }
}

function Get-RtlNodeVersion {
  param([string]$NodeExe)
  $text = & $NodeExe --version
  return ($text -replace '^v', '')
}

function Assert-RtlNode24 {
  param([string]$NodeExe)
  $version = Get-RtlNodeVersion $NodeExe
  $major = [int]($version.Split('.')[0])
  if ($major -lt 24) {
    throw "Node.js >= 24 is required (found $version)."
  }
}
