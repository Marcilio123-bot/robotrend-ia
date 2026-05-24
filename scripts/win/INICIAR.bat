@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."

echo.
echo ============================================
echo   ROBOTREND IA - INICIANDO SERVIDOR
echo ============================================
echo.

if not exist "node_modules" (
  echo [INFO] Dependencias nao instaladas. Rodando INSTALAR.bat...
  call "%~dp0INSTALAR.bat"
)

echo.
echo Painel:  http://localhost:3010
echo Health:  http://localhost:3010/api/health
echo.
echo Pressione CTRL+C para parar.
echo ============================================
echo.

start http://localhost:3010
node backend/server.js
pause
