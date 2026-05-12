'use strict';

// Упаковка собранного каталога в zip через PowerShell Compress-Archive.
// Запускать после `npm run build`.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const version = pkg.version;
const appName = 'Диспетчер Водоснабжения';
const unpackedDir = path.join(__dirname, '..', 'dist', `${appName}-win32-x64`);
const zipPath = path.join(__dirname, '..', 'dist', `DispatcherWater-${version}-win-x64.zip`);

if (!fs.existsSync(unpackedDir)) {
  console.error(`[build-zip] Каталог ${unpackedDir} не найден. Сначала выполните "npm run build".`);
  process.exit(1);
}

try { fs.rmSync(zipPath, { force: true }); } catch {}

const psCmd = `Compress-Archive -Path '${unpackedDir}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`;
console.log('[build-zip] Упаковка в', zipPath);
execSync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, { stdio: 'inherit' });

const size = fs.statSync(zipPath).size;
console.log(`[build-zip] Готово: ${zipPath} (${(size / 1024 / 1024).toFixed(1)} МБ)`);
