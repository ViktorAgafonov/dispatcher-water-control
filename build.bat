@echo off
REM Сборка Windows-приложения "Диспетчер Водоснабжения" (x64) через electron-packager.
REM Результат: dist\Диспетчер Водоснабжения-win32-x64\Диспетчер Водоснабжения.exe
REM Опционально: zip-архив dist\ДиспетчерВодоснабжения-<ver>-win-x64.zip.

setlocal

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm не найден в PATH. Установите Node.js (https://nodejs.org/).
  exit /b 1
)

if not exist node_modules (
  echo [1/3] Установка зависимостей...
  call npm install
  if errorlevel 1 exit /b 1
) else (
  echo [1/3] node_modules уже существует, пропускаю установку.
)

echo [2/3] Сборка...
call npm run build
if errorlevel 1 (
  echo [ERROR] Сборка завершилась с ошибкой.
  exit /b 1
)

if /i "%~1"=="zip" (
  echo [3/3] Упаковка в zip...
  call npm run build:zip
  if errorlevel 1 exit /b 1
) else (
  echo [3/3] Пропускаю упаковку в zip (запустите "build.bat zip" при необходимости).
)

echo.
echo Готово. Содержимое dist\:
dir /b dist 2>nul

endlocal
