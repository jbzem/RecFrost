@echo off
setlocal
if "%~1"=="" (
	echo Usage: deploy.bat ^<app^>
	echo   Example: deploy.bat cdn
	echo.
	echo Deploys apps\^<app^> to Cloudflare using the repo root .env settings.
	echo Requires: bun on PATH, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the env.
	echo Set RECFLARE_INSECURE_TLS=1 if a corporate proxy/VPN blocks Cloudflare TLS.
	exit /b 1
)
set "APP=%~1"
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\deploy.ps1" -App "%APP%" -Root "%ROOT%"
exit /b %ERRORLEVEL%
