@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   一鍵 Git Push（只推工具，敏感檔已自動排除）
echo ============================================
echo.
set "msg="
set /p msg=請輸入本次更新說明（直接 Enter 用時間戳）: 
if "%msg%"=="" set "msg=update %date% %time%"
echo.
echo [1/3] git add...
git add -A
echo [2/3] git commit...
git commit -m "%msg%"
echo [3/3] git push...
git push
echo.
echo 完成！可關閉視窗。
pause
