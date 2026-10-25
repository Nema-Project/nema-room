@echo off
rem Runs the bundled CLI with the bundled Node; every argument is forwarded and the exit code is preserved.
setlocal
set "ROOT=%~dp0"
"%ROOT%{{NODE_PATH}}" "%ROOT%{{CLI_PATH}}" %*
exit /b %errorlevel%
