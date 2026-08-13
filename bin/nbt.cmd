@echo off
REM Managed by NiuBot: nbt cmd launcher (Windows entry alongside bin\nbt)
setlocal
set "PROJECT_DIR=%~dp0.."
if exist "%PROJECT_DIR%\node_modules\.bin\tsx.cmd" if exist "%PROJECT_DIR%\src\cli.ts" (
  call "%PROJECT_DIR%\node_modules\.bin\tsx.cmd" "%PROJECT_DIR%\src\cli.ts" %*
  exit /b %errorlevel%
)
node "%PROJECT_DIR%\dist\cli.js" %*
exit /b %errorlevel%
