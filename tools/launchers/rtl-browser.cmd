@echo off
rem Copyright 2026 Frank Gao
rem
rem Licensed under the Apache License, Version 2.0 (the "License");
rem you may not use this file except in compliance with the License.
rem You may obtain a copy of the License at
rem
rem     http://www.apache.org/licenses/LICENSE-2.0
rem
rem Unless required by applicable law or agreed to in writing, software
rem distributed under the License is distributed on an "AS IS" BASIS,
rem WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
rem See the License for the specific language governing permissions and
rem limitations under the License.

setlocal
set "ROOT=%~dp0..\.."
if defined RTL_NODE (
  set "NODE=%RTL_NODE%"
) else (
  set "NODE=node"
  for /d %%D in ("%ROOT%\.sandbox\deps\node-v*-win-x64") do (
    if exist "%%D\node.exe" set "NODE=%%D\node.exe"
  )
)
"%NODE%" "%ROOT%\tools\launchers\rtl-browser.mjs" %*
exit /b %ERRORLEVEL%
