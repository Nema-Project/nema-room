@echo off
rem The browser entry validates launch URLs and accepts --no-open for automated smoke.
setlocal
set "ROOT=%~dp0"
"%ROOT%{{NODE_PATH}}" "%ROOT%app\node_modules\@nema\local\dist\src\browser.js" --assetsDir "%ROOT%." %*
exit /b %errorlevel%
