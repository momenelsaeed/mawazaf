@echo off
title Mawazaf AI
cd /d "D:\مشروعي"
echo Closing old server if running...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
timeout /t 2 >nul
if not exist "node_modules" (
  echo Installing for first time...
  call npm install
)
echo.
echo Server starting - keep this window open
echo Site: http://localhost:3000/site.html (للمرضى)
echo Dashboard: http://localhost:3000 (للموظفين)
timeout /t 3 >nul
start "" "http://localhost:3000/site.html"
start "" "http://localhost:3000"
call npm run dev
pause
