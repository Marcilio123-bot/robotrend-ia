@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."

echo.
echo ============================================
echo   ROBOTREND IA - INSTALADOR
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Baixe em https://nodejs.org
  pause
  exit /b 1
)

if not exist "logs" mkdir logs

echo [1/2] Instalando dependencias (pode levar ate 2 min)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo [ERRO] Falha ao instalar dependencias.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   INSTALACAO CONCLUIDA!
echo ============================================
echo.
echo Para iniciar: INICIAR.bat na raiz do projeto
echo                 (ou: npm start)
echo.
pause
