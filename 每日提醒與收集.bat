@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   每日提醒 + 聊天收集（手動執行）
echo ============================================
echo.
echo [1/4] 確保服務啟動 (PM2)...
call "C:\Program Files\nodejs\npx.cmd" pm2 resurrect
timeout /t 4 >nul
echo.
echo [2/4] 收集近一天聊天紀錄...
node src/bot.js --recent 1
echo.
echo [3/4] 更新各群工作提醒看板...
node src/bot.js --update-boards
echo.
echo [4/4] 推送所有未完成任務提醒...
curl -s -X POST http://localhost:3100/api/remind-all
echo.
echo.
echo 完成！可關閉視窗。
pause
