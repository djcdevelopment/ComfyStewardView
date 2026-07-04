@echo off
setlocal

set "SCRIPT_DIR=%~dp0"

where mvn >nul 2>nul
if "%ERRORLEVEL%"=="0" (
  mvn %*
  exit /b %ERRORLEVEL%
)

if exist "%SCRIPT_DIR%..\.tools\apache-maven-3.9.6\bin\mvn.cmd" (
  call "%SCRIPT_DIR%..\.tools\apache-maven-3.9.6\bin\mvn.cmd" %*
  exit /b %ERRORLEVEL%
)

echo Maven is not installed yet for this repo.
echo Run Start-Viewer.ps1 from the repo root once. It will download Maven automatically.
exit /b 1
