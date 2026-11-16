@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0server"
echo ==============================================
echo   혜택 알리미 서버 설정 도우미
echo ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js 가 설치되어 있지 않습니다.
  echo     https://nodejs.org 에서 LTS 버전^(22.5 이상^)을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
echo 공공데이터포털에서 받은 일반 인증키(Decoding)를 붙여넣고 Enter 를 누르세요.
echo ^(마우스 오른쪽 클릭 = 붙여넣기^)
echo.
set /p APIKEY=인증키: 
if "%APIKEY%"=="" (
  echo [!] 인증키가 비어 있습니다. 다시 실행하세요.
  pause
  exit /b 1
)
set TOKEN=hx-%RANDOM%%RANDOM%%RANDOM%%RANDOM%%RANDOM%
> .env echo DATA_GO_KR_KEY=%APIKEY%
>> .env echo PORT=8080
>> .env echo DB_PATH=./data/hyetaek.db
>> .env echo ADMIN_TOKEN=%TOKEN%
>> .env echo SYNC_HOUR=4
>> .env echo GOV24_BASE=https://api.odcloud.kr/api
echo.
echo 설정이 저장되었습니다.
echo.
echo   관리자 비밀번호(ADMIN_TOKEN): %TOKEN%
echo   ^(관리자 화면 로그인에 쓰이니 메모해 두세요^)
echo.
echo 이제 start.bat 을 더블클릭하면 서버가 켜집니다.
echo.
pause
