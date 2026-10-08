@echo off
setlocal

rem Keep the ready-to-run and installed copies aligned with workspace changes,
rem then open the installed copy so normal shortcuts and this launcher agree.
if exist "%~dp0scripts\ensure-desktop-current.ps1" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-desktop-current.ps1"
  if not errorlevel 1 exit /b 0
  echo.
  echo Span could not be refreshed. Opening the newest available copy.
)

if exist "%~dp0apps\desktop\release\win-unpacked\Span.exe" (
  start "" "%~dp0apps\desktop\release\win-unpacked\Span.exe"
  exit /b 0
)

if exist "%LOCALAPPDATA%\Programs\Span\Span.exe" (
  start "" "%LOCALAPPDATA%\Programs\Span\Span.exe"
  exit /b 0
)

if exist "%LOCALAPPDATA%\Programs\browser-agent\Span.exe" (
  start "" "%LOCALAPPDATA%\Programs\browser-agent\Span.exe"
  exit /b 0
)

if exist "%LOCALAPPDATA%\Programs\Browser Agent\Span.exe" (
  start "" "%LOCALAPPDATA%\Programs\Browser Agent\Span.exe"
  exit /b 0
)

echo Span is not built yet.
echo Ask Codex to run the desktop updater, then try again.
pause
exit /b 1
