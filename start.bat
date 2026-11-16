@echo off
chcp 65001 >nul
cd /d "%~dp0server"
if not exist .env (
  echo [!] 먼저 setup.bat 을 실행해 설정을 만드세요.
  pause
  exit /b 1
)
echo 서버를 시작합니다. 이 창을 닫으면 서버가 꺼집니다.
echo   앱     : http://localhost:8080
echo   관리자 : http://localhost:8080/admin
echo.
start "" http://localhost:8080/admin
node --disable-warning=ExperimentalWarning src/server.js
pause
