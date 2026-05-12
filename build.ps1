#Requires -Version 5
# Сборка Windows-приложения Pulsar Monitor (x64) через @electron/packager.
# Использование:
#   .\build.ps1          # только каталог с .exe
#   .\build.ps1 -Zip     # дополнительно запаковать в zip

param(
  [switch]$Zip
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error 'npm не найден в PATH. Установите Node.js (https://nodejs.org/).'
  exit 1
}

if (-not (Test-Path 'node_modules')) {
  Write-Host '[1/3] Установка зависимостей...'
  npm install
} else {
  Write-Host '[1/3] node_modules уже существует, пропускаю установку.'
}

Write-Host '[2/3] Сборка (electron-packager)...'
npm run build

if ($Zip) {
  Write-Host '[3/3] Упаковка в zip...'
  npm run build:zip
} else {
  Write-Host '[3/3] Пропускаю упаковку в zip (запустите ".\build.ps1 -Zip" при необходимости).'
}

Write-Host ''
Write-Host 'Готово. Содержимое dist\:'
Get-ChildItem -Path 'dist' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $size = if ($_.PSIsContainer) { '<DIR>' } else { "$([Math]::Round($_.Length/1MB,1)) МБ" }
    Write-Host "  $($_.Name)  $size"
  }
