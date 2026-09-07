@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem Run Codex from a Cyberboss-owned snapshot. The desktop updater may remove a
rem companion executable from its version directory while this bridge is alive.
rem Keeping all sibling executables together in a stable directory prevents MCP
rem programmatic-tool calls from breaking during an in-place Codex update.
if "%CYBERBOSS_CODEX_BIN_ROOT%"=="" (
    set "CODEX_BIN_ROOT=%LOCALAPPDATA%\OpenAI\Codex\bin"
) else (
    set "CODEX_BIN_ROOT=%CYBERBOSS_CODEX_BIN_ROOT%"
)
set "STABLE_ROOT=%~dp0..\..\state\codex-runtime"
set "CODEX_EXE=%STABLE_ROOT%\codex.exe"

call :is_complete "%STABLE_ROOT%"
if not errorlevel 1 goto :run

set "SOURCE_DIR="
for /f "delims=" %%d in ('dir /b /ad /o-d "%CODEX_BIN_ROOT%" 2^>nul') do (
    call :is_complete "%CODEX_BIN_ROOT%\%%d"
    if not errorlevel 1 if not defined SOURCE_DIR set "SOURCE_DIR=%CODEX_BIN_ROOT%\%%d"
)

if not defined SOURCE_DIR (
    echo A complete Codex runtime was not found under %CODEX_BIN_ROOT% >&2
    exit /b 1
)

if not exist "%STABLE_ROOT%" mkdir "%STABLE_ROOT%" >nul 2>&1
for %%f in (codex.exe codex-code-mode-host.exe codex-command-runner.exe codex-windows-sandbox-setup.exe) do (
    copy /b /y "%SOURCE_DIR%\%%f" "%STABLE_ROOT%\%%f" >nul
    if errorlevel 1 (
        echo Failed to snapshot %%f from %SOURCE_DIR% >&2
        exit /b 1
    )
)

call :is_complete "%STABLE_ROOT%"
if errorlevel 1 (
    echo The Cyberboss Codex runtime snapshot is incomplete: %STABLE_ROOT% >&2
    exit /b 1
)

:run
"%CODEX_EXE%" %*
exit /b %errorlevel%

:is_complete
if not exist "%~1\codex.exe" exit /b 1
if not exist "%~1\codex-code-mode-host.exe" exit /b 1
if not exist "%~1\codex-command-runner.exe" exit /b 1
if not exist "%~1\codex-windows-sandbox-setup.exe" exit /b 1
exit /b 0
