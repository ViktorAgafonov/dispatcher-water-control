'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const {
  buildReadChannelsRequest, parseReadChannelsResponse,
  buildReadParamRequest, parseReadParamResponse,
  PARAM_FLOW_RATE,
} = require('./src/pulsar');
const sigur = require('./src/sigur');
const { request } = require('./src/tcpClient');
const logger = require('./src/logger');
const { StatsStore } = require('./src/stats');

let mainWindow = null;
let splashWindow = null;
let tray = null;
let pollTimer = null;
let currentConfig = null;
let stats = null;
let quitting = false; // флаг: true — реальный выход, иначе close/minimize прячет в трей.
// Состояние доступности каждого узла (по индексу), чтобы логировать только смену.
const availability = new Map();

const METER_DEFAULTS = {
  enabled: true,
  dayStartHour: 0,       // 0..23, в который начинаются сутки
  weekStartDay: 1,       // 1=Пн..7=Вс
};

// Дефолты для счётчиков дренажа (Эхо Сигнур): сетевой адрес — 1..247.
const DRAINAGE_METER_DEFAULTS = {
  ...METER_DEFAULTS,
  kind: 'drainage',
};

// Ограничения интервала опроса (для оптимизации обмена).
const MIN_POLL_SEC = 10;
const MAX_POLL_SEC = 120 * 60; // 120 минут
function clampInterval(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return 30;
  return Math.min(MAX_POLL_SEC, Math.max(MIN_POLL_SEC, Math.round(n)));
}

const DEFAULT_CONFIG = {
  pollIntervalSec: 30,
  timeoutMs: 3000,
  meters: [
    { name: 'Цех 1', host: '192.168.1.101', port: 4001, device: '12345', channel: 1, ...METER_DEFAULTS },
    { name: 'Цех 2', host: '192.168.1.102', port: 4001, device: '12346', channel: 1, ...METER_DEFAULTS },
    { name: 'Цех 3', host: '192.168.1.103', port: 4001, device: '12347', channel: 1, ...METER_DEFAULTS },
  ],
  drainageMeters: [
    { name: 'Колодец 1', host: '192.168.1.111', port: 4001, device: '1', ...DRAINAGE_METER_DEFAULTS },
    { name: 'Колодец 2', host: '192.168.1.112', port: 4001, device: '2', ...DRAINAGE_METER_DEFAULTS },
    { name: 'Колодец 3', host: '192.168.1.113', port: 4001, device: '3', ...DRAINAGE_METER_DEFAULTS },
  ],
};

function normalizeMeter(m) {
  return { ...METER_DEFAULTS, ...m };
}

function normalizeDrainageMeter(m) {
  return { ...DRAINAGE_METER_DEFAULTS, ...m, kind: 'drainage' };
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  let cfg;
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    cfg = JSON.parse(raw);
  } catch {
    cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  const meters = (cfg.meters && cfg.meters.length ? cfg.meters : DEFAULT_CONFIG.meters).map(normalizeMeter);
  // Миграция: drainageMeters могло отсутствовать в старом конфиге — подставляем дефолты.
  const drainSrc = (cfg.drainageMeters && cfg.drainageMeters.length)
    ? cfg.drainageMeters
    : DEFAULT_CONFIG.drainageMeters;
  const drainageMeters = drainSrc.map(normalizeDrainageMeter);
  return { ...DEFAULT_CONFIG, ...cfg, meters, drainageMeters };
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

// Чтение объёма (м³) и мгновенного расхода (м³/ч) с одного счётчика.
// TCP-соединение переоткрывается для каждого запроса — подходяще для конвертеров RS-485↔Ethernet,
// которые часто работают в режиме «one-shot».
async function pollMeter(meter, timeoutMs, tag) {
  const ch = Number(meter.channel) || 1;
  const host = meter.host;
  const port = Number(meter.port);

  // 1) Объём (F=0x01).
  const v = buildReadChannelsRequest(meter.device, ch);
  const respV = await request(host, port, v.packet, { timeoutMs, tag });
  const parsedV = parseReadChannelsResponse(respV, meter.device, v.id.readUInt16LE(0), meter.valueType ? { valueType: meter.valueType } : {});
  const volume = parsedV.channels[0];

  // 2) Расход (F=0x0A, параметр 0x0100). Если счётчик не поддерживает — логируем и продолжаем.
  let flow = null;
  let flowError = null;
  try {
    const f = buildReadParamRequest(meter.device, PARAM_FLOW_RATE);
    const respF = await request(host, port, f.packet, { timeoutMs, tag });
    const parsedF = parseReadParamResponse(respF, meter.device, f.id.readUInt16LE(0));
    flow = parsedF.value;
  } catch (e) {
    flowError = e.message;
    logger.warn(tag, `Расход не получен: ${e.message}`);
  }

  return { volume, flow, flowError };
}

// Опрос счётчика дренажа «Эхо Сигнур» — Modbus fn=0x03, регистры 0..9, ответ 25 байт.
async function pollDrainageMeter(meter, timeoutMs, tag) {
  const addr = Number(meter.device);
  const host = meter.host;
  const port = Number(meter.port);
  const packet = sigur.buildReadCurrentRequest(addr);
  const resp = await request(host, port, packet, { timeoutMs, tag, expectedLen: 25 });
  const r = sigur.parseReadCurrentResponse(resp, addr);
  return { volume: r.volume, flow: r.flow, flowError: null, level: r.level, serial: r.serial };
}

function updateAvailability(idx, meter, ok, detail) {
  const prev = availability.get(idx);
  if (prev === ok) return;
  availability.set(idx, ok);
  const tag = meter.name || `Счётчик ${idx + 1}`;
  if (ok) logger.info(tag, `Узел доступен (${meter.host}:${meter.port})`);
  else    logger.warn(tag, `Узел недоступен: ${detail || 'нет связи'}`);
}

// Флаг, чтобы новый опрос не наезжал на предыдущий (если интервал короче длительности обхода).
let pollInProgress = false;

// Параллельный опрос всех счётчиков заданного типа (water/drainage).
// Разные счётчики опрашиваются одновременно (Promise.all); внутри каждого
// pollMeter/pollDrainageMeter запросы остаются строго последовательными.
async function pollKind(list, timeoutMs, kind) {
  const isDrn = kind === 'drainage';
  return Promise.all(list.map(async (m, idx) => {
    const ts = new Date().toISOString();
    const tag = m.name || `${isDrn ? 'Колодец' : 'Цех'} ${idx + 1}`;
    if (m.enabled === false) {
      return { idx, name: m.name, disabled: true, timestamp: ts };
    }
    logger.debug(tag, `Опрос: ${isDrn ? 'Сигнур, ' : ''}№${m.device}${m.channel ? `, канал ${m.channel}` : ''}`);
    const t0 = Date.now();
    try {
      const r = isDrn
        ? await pollDrainageMeter(m, timeoutMs, tag)
        : await pollMeter(m, timeoutMs, tag);
      const dt = Date.now() - t0;
      const flowStr = r.flow != null ? `, расход: ${Number(r.flow).toFixed(3)} м³/ч` : '';
      logger.info(tag, `Объём: ${Number(r.volume).toFixed(3)} м³${flowStr} (за ${dt} мс)`);
      updateAvailability(`${kind}:${idx}`, m, true);
      const usage = stats.record(m, Number(r.volume), ts);
      const out = {
        idx, name: m.name, ok: true, value: r.volume, flow: r.flow, flowError: r.flowError,
        timestamp: ts,
        dayUsage: usage.dayUsage, weekUsage: usage.weekUsage,
        dayStartTs: usage.dayStartTs, weekStartTs: usage.weekStartTs,
        dayFirstTs: usage.dayFirstTs, weekFirstTs: usage.weekFirstTs,
        durationMs: dt,
      };
      if (isDrn) { out.errorCode = r.errorCode; out.level = r.level; }
      return out;
    } catch (e) {
      const dt = Date.now() - t0;
      const codeInfo = e.deviceErrorCode != null ? ` [код 0x${e.deviceErrorCode.toString(16).padStart(2,'0').toUpperCase()}]` : '';
      logger.error(tag, `Опрос не удался${codeInfo} (за ${dt} мс): ${e.message}`);
      updateAvailability(`${kind}:${idx}`, m, false, e.message);
      return { idx, name: m.name, ok: false, error: e.message, deviceErrorCode: e.deviceErrorCode, timestamp: ts, durationMs: dt };
    }
  }));
}

async function pollAll() {
  if (!currentConfig || !mainWindow) return;
  if (pollInProgress) {
    logger.debug('app', 'Пропуск опроса: предыдущий ещё не завершён');
    return;
  }
  pollInProgress = true;
  try {
    const timeoutMs = Number(currentConfig.timeoutMs) || 3000;
    const waterResults    = await pollKind(currentConfig.meters || [],         timeoutMs, 'water');
    const drainageResults = await pollKind(currentConfig.drainageMeters || [], timeoutMs, 'drainage');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('poll-result', waterResults);
      mainWindow.webContents.send('poll-result-drainage', drainageResults);
    }
    updateTrayTooltip([...waterResults, ...drainageResults]);
  } finally {
    pollInProgress = false;
  }
}

function restartPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // Интервал жёстко ограничиваем в рамках [MIN_POLL_SEC; MAX_POLL_SEC] — от перелётного опроса и от исчезнувшего опроса.
  const intervalSec = clampInterval(currentConfig.pollIntervalSec);
  if (intervalSec !== Number(currentConfig.pollIntervalSec)) {
    logger.warn('app', `Интервал опроса приведён к допустимому диапазону: ${intervalSec} с (диапазон ${MIN_POLL_SEC}…${MAX_POLL_SEC} с)`);
    currentConfig.pollIntervalSec = intervalSec;
  }
  const interval = intervalSec * 1000;
  const waterEn = currentConfig.meters.filter((m) => m.enabled !== false).length;
  const drnList = currentConfig.drainageMeters || [];
  const drnEn = drnList.filter((m) => m.enabled !== false).length;
  logger.info('app', `Опрос перезапущен: интервал ${intervalSec} с, таймаут ${currentConfig.timeoutMs} мс, ` +
    `водомеров активно ${waterEn}/${currentConfig.meters.length}, дренаж активно ${drnEn}/${drnList.length}`);
  // Сброс состояния доступности, чтобы первый результат залогировался.
  availability.clear();
  // Чистим статистику от удалённых счётчиков (учитываем оба списка).
  if (stats) {
    const keys = [
      ...currentConfig.meters.map((m) => StatsStore.keyOf(m)),
      ...drnList.map((m) => StatsStore.keyOf(m)),
    ];
    stats.prune(keys);
  }
  // Первый опрос — сразу, затем по интервалу.
  pollAll();
  pollTimer = setInterval(pollAll, interval);
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 80,
    height: 80,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.setMenuBarVisibility(false);
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splashWindow.on('closed', () => { splashWindow = null; });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    show: false,                 // показываем только после готовности, чтобы не мигало белым
    backgroundColor: '#f4f6f9',
    icon: makeAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const closeSplash = () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  };

  // Как только UI отрисован — показываем главное окно и закрываем splash.
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    closeSplash();
  });
  // Страховка: даже при ошибке загрузки закрыть splash, чтобы пользователь не завис.
  mainWindow.webContents.on('did-fail-load', closeSplash);
  setTimeout(closeSplash, 15000);

  // Сворачивание в трей: при minimize прячем окно (опрос продолжается в фоне).
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
  // Крестик (close) — реальное закрытие приложения.
  mainWindow.on('close', () => { quitting = true; });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Генерация 16x16 PNG-иконки для трея и окна (без внешних файлов).
// Синий круг на прозрачном фоне.
function makeAppIcon() {
  const W = 16;
  const buf = Buffer.alloc(W * W * 4);
  const cx = (W - 1) / 2, cy = (W - 1) / 2, r = 7.2;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) {
        // BGRA на Windows для createFromBitmap.
        buf[i]     = 235; // B
        buf[i + 1] = 99;  // G
        buf[i + 2] = 37;  // R
        buf[i + 3] = 255; // A
      } else if (d <= r + 0.7) {
        const a = Math.round(255 * (1 - (d - r) / 0.7));
        buf[i]     = 235; buf[i + 1] = 99; buf[i + 2] = 37; buf[i + 3] = a;
      } else {
        buf[i + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: W, height: W });
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(makeAppIcon());
  } catch (e) {
    logger.warn('app', `Не удалось создать tray: ${e.message}`);
    return;
  }
  tray.setToolTip('Pulsar Monitor');
  const menu = Menu.buildFromTemplate([
    { label: 'Показать окно', click: () => showMainWindow() },
    { label: 'Опросить сейчас', click: () => pollAll() },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function updateTrayTooltip(results) {
  if (!tray || tray.isDestroyed()) return;
  const lines = ['Диспетчер Водоснабжения'];
  for (const r of results || []) {
    const full = r.name || `Счётчик ${(r.idx ?? 0) + 1}`;
    const name = full.length > 12 ? full.slice(0, 11) + '…' : full;
    if (r.disabled) lines.push(`${name}: откл`);
    else if (r.ok)  lines.push(`${name}: ${Number(r.value).toFixed(1)}м³`);
    else            lines.push(`${name}: ошибка`);
  }
  // Windows NOTIFYICONDATA: ≤127 символов. Обрезаем по последней целой строке.
  let tip = lines.join('\n');
  if (tip.length > 127) {
    const cut = tip.slice(0, 127);
    const nl = cut.lastIndexOf('\n');
    tip = nl > 0 ? cut.slice(0, nl) : cut;
  }
  tray.setToolTip(tip);
}

// Один-единственный экземпляр: второй запуск выводит главное окно видимым.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

app.whenReady().then(() => {
  currentConfig = loadConfig();
  stats = new StatsStore(path.join(app.getPath('userData'), 'stats.json'));
  // Сначала — splash (мгновенная обратная связь), затем — основное окно.
  createSplashWindow();
  createMainWindow();
  createTray();
  mainWindow.webContents.once('did-finish-load', () => {
    restartPolling();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMainWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (stats) stats.flush();
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }
});

// window-all-closed не должен завершать приложение в Windows: оно живёт в трее.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && quitting) app.quit();
});

// IPC
ipcMain.handle('config:get', () => currentConfig);

ipcMain.handle('config:set', (_e, cfg) => {
  // Нормализуем интервал опроса и приводим списки счётчиков к каноничному виду.
  cfg.pollIntervalSec = clampInterval(cfg.pollIntervalSec);
  cfg.meters = (cfg.meters || []).map(normalizeMeter);
  cfg.drainageMeters = (cfg.drainageMeters || []).map(normalizeDrainageMeter);
  currentConfig = cfg;
  saveConfig(currentConfig);
  logger.info('app', 'Настройки сохранены');
  restartPolling();
  return currentConfig;
});

ipcMain.handle('poll:now', async () => {
  logger.info('app', 'Ручной опрос');
  await pollAll();
  return true;
});

ipcMain.handle('logs:get', () => logger.all());
ipcMain.handle('logs:clear', () => { logger.clear(); return true; });

ipcMain.handle('stats:get', () => {
  if (!stats || !currentConfig) return [];
  return currentConfig.meters.map((m) => ({
    key: StatsStore.keyOf(m),
    snapshot: stats.snapshot(m),
  }));
});

ipcMain.handle('stats:get-drainage', () => {
  if (!stats || !currentConfig) return [];
  return (currentConfig.drainageMeters || []).map((m) => ({
    key: StatsStore.keyOf(m),
    snapshot: stats.snapshot(m),
  }));
});

ipcMain.handle('stats:get-history', () => {
  if (!stats || !currentConfig) return { water: [], drainage: [] };
  const build = (list, kind) => (list || []).map((m, idx) => {
    const key = StatsStore.keyOf({ ...m, kind });
    const md = stats.data.meters[key] || null;
    return {
      idx, kind,
      name: m.name || null,
      enabled: m.enabled !== false,
      history: md ? (md.history || []) : [],
      lastValue: md ? md.lastValue : null,
      lastTs: md ? md.lastTs : null,
    };
  });
  return {
    water:    build(currentConfig.meters || [],         'water'),
    drainage: build(currentConfig.drainageMeters || [], 'drainage'),
  };
});

ipcMain.handle('report:save', async (_e, { content, defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Сохранить отчёт',
    defaultPath: defaultName || 'report.csv',
    filters: [{ name: 'CSV файлы', extensions: ['csv'] }, { name: 'Все файлы', extensions: ['*'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
ipcMain.handle('app:hide', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.handle('app:version', () => app.getVersion());

// Рассылка новых записей лога в renderer.
logger.on('entry', (entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-append', entry);
  }
});
logger.on('clear', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-clear');
  }
});
