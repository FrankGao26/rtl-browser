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
