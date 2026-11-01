@echo off
rem Runs the bundled CLI with Electron's Node; every argument is forwarded and the exit code is preserved.
setlocal
set "ROOT=%~dp0"
set ELECTRON_RUN_AS_NODE=1
"%ROOT%{{NODE_PATH}}" "%ROOT%{{CLI_PATH}}" %*
exit /b %errorlevel%
