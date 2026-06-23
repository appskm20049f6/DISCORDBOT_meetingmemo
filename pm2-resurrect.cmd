@echo off
set LOG=%USERPROFILE%\.pm2\resurrect-boot.log
echo ==== %DATE% %TIME% pm2 resurrect start ==== >> "%LOG%"
cd /d "%~dp0"
call "C:\Program Files\nodejs\npx.cmd" pm2 resurrect >> "%LOG%" 2>&1
echo ==== %DATE% %TIME% pm2 resurrect end ==== >> "%LOG%"
