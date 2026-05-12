'use strict';

// Пост-обработка собранного каталога:
// - оставляем только ru.pak и en-US.pak в locales/ (удаляем остальные 50+ языков);
// - удаляем LICENSES.chromium.html.
//
// ffmpeg.dll НЕ удаляем: Electron/Chromium грузит его на старте (даже если видео/аудио
// в приложении не используется) — без него приложение не запускается.
//
// UPX-сжатие не применяется: PE-файлы Electron собраны с Control Flow Guard (GUARD_CF),
// и UPX отказывается их паковать. --force ведёт к нестабильной работе.

const fs = require('fs');
const path = require('path');

const appName = 'Диспетчер Водоснабжения';
const root = path.join(__dirname, '..', 'dist', `${appName}-win32-x64`);

if (!fs.existsSync(root)) {
  console.error(`[post-build] Каталог ${root} не найден. Сначала запустите "npm run build".`);
  process.exit(1);
}

const KEEP_LOCALES = new Set(['ru.pak', 'en-US.pak']);

let removed = 0;
let freedBytes = 0;

function rmFile(p) {
  try {
    const st = fs.statSync(p);
    fs.rmSync(p, { force: true });
    removed++;
    freedBytes += st.size;
  } catch {}
}

// 1) Очистка локалей
const localesDir = path.join(root, 'locales');
if (fs.existsSync(localesDir)) {
  for (const f of fs.readdirSync(localesDir)) {
    if (!KEEP_LOCALES.has(f)) rmFile(path.join(localesDir, f));
  }
}

// 2) LICENSES.chromium.html
rmFile(path.join(root, 'LICENSES.chromium.html'));

console.log(`[post-build] Удалено файлов: ${removed}, освобождено: ${(freedBytes / 1024 / 1024).toFixed(1)} МБ`);
