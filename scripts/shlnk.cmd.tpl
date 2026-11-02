@echo off
setlocal
set "APP=%~dp0Shellink.exe"

if not exist "%APP%" (
  echo [shlnk] Shellink.exe was not found next to this script.
  exit /b 1
)

if "%~1"=="" goto open
if /i "%~1"=="--help" goto help
if /i "%~1"=="-h" goto help
if /i "%~1"=="/?" goto help
if /i "%~1"=="--version" goto version
if /i "%~1"=="-v" goto version
if /i "%~1"=="--local" goto local
if /i "%~1"=="-l" goto local
if /i "%~1"=="--connect" goto two
if /i "%~1"=="-c" goto two
goto one

:open
start "" "%APP%"
exit /b 0

:local
start "" "%APP%" --local
exit /b 0

:one
start "" "%APP%" --connect "%~1"
exit /b 0

:two
if "%~2"=="" goto help
start "" "%APP%" --connect "%~2"
exit /b 0

:version
echo Shellink __VERSION__
exit /b 0

:help
echo.
echo   shlnk - Shellink command line
echo.
echo   Usage:
echo     shlnk                      Open Shellink
echo     shlnk user@host[:port]     Connect to a host
echo     shlnk --local              Open a local terminal
echo     shlnk --version            Show version
echo     shlnk --help               Show this help
echo.
exit /b 0
