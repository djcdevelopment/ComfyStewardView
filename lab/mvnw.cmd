@echo off
setlocal
set "SCRIPT_DIR=%~dp0"

set "SHARED_TOOLS=%SCRIPT_DIR%..\.tools"
if not exist "%SHARED_TOOLS%\apache-maven-3.9.6\bin\mvn.cmd" set "SHARED_TOOLS=%SCRIPT_DIR%..\comfystewardview\.tools"
if not defined JAVA_HOME if exist "%SHARED_TOOLS%\jdk-17.0.19+10\bin\java.exe" set "JAVA_HOME=%SHARED_TOOLS%\jdk-17.0.19+10"

where mvn >nul 2>nul
if not errorlevel 1 goto system_maven
goto bundled_maven

:system_maven
mvn %*
exit /b %ERRORLEVEL%

:bundled_maven
if exist "%SHARED_TOOLS%\apache-maven-3.9.6\bin\mvn.cmd" goto have_bundled_maven

echo Maven is unavailable. Install Maven or run Start-Viewer.ps1 from the parent repository once.
exit /b 1

:have_bundled_maven
call "%SHARED_TOOLS%\apache-maven-3.9.6\bin\mvn.cmd" %*
exit /b %ERRORLEVEL%
