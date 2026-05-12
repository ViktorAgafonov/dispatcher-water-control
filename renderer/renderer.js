'use strict';

// Переключение вкладок
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('tab-' + t.dataset.tab).classList.add('active');
  });
});

const SVG_NS = 'http://www.w3.org/2000/svg';
let cfg = null;
// Состояние по двум видам учёта. Индексы 0..2 — соответствуют записям в cfg.meters / cfg.drainageMeters.
const state = {
  water:    { lastResults: [null, null, null], statsSnapshots: [null, null, null] },
  drainage: { lastResults: [null, null, null], statsSnapshots: [null, null, null] },
};
// Сохраняем глобальные ссылки lastResults/statsSnapshots ради обратной совместимости с тестовым инжектором.
let lastResults = state.water.lastResults;
let statsSnapshots = state.water.statsSnapshots;

// Параметры мнемосхемы для каждого вида учёта.
const KIND_CFG = {
  water: {
    svgId: 'mnemonic',
    listKey: 'meters',
    title: 'Схема водоснабжения цехов',
    mainLabel: 'Холодная вода',
    branchLabel: 'В ЦЕХ',
    workshopWord: 'Производственный',
    nodeLabel: 'УЗЕЛ УЧЁТА',
    meterTitlePrefix: 'Счётчик № ',
    side: 'right',     // магистраль слева, цеха справа, поток слева→направо
    theme: 'water',
    fallbackName: (i) => `Цех ${i + 1}`,
  },
  drainage: {
    svgId: 'mnemonic-drainage',
    listKey: 'drainageMeters',
    title: 'Схема водоотведения цехов',
    mainLabel: 'Сточная вода',
    branchLabel: 'СТОК',
    workshopWord: 'Сток',
    nodeLabel: 'КОЛОДЕЦ-СЧЁТЧИК',
    meterTitlePrefix: 'Сигнур №',
    side: 'left',      // цеха слева, магистраль справа, поток слева→направо (от цеха в сток)
    theme: 'drainage',
    fallbackName: (i) => `Цех ${i + 1}`,
  },
};

function getList(kind) {
  return cfg ? (cfg[KIND_CFG[kind].listKey] || []) : [];
}

function el(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtValue(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toFixed(3);
}

function ageText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин назад`;
}

// Задвижка (ball valve): два треугольника, соединённые вершинами.
function valve(cx, cy, size = 12) {
  const g = el('g');
  const s = size;
  g.appendChild(el('polygon', {
    points: `${cx - s},${cy - s} ${cx - s},${cy + s} ${cx},${cy}`,
    class: 'valve',
  }));
  g.appendChild(el('polygon', {
    points: `${cx + s},${cy - s} ${cx + s},${cy + s} ${cx},${cy}`,
    class: 'valve',
  }));
  return g;
}

// Стрелка-наконечник трубы. Цвет задаётся через класс pipe-arrow (зависит от темы).
function arrowHead(x, y, dir = 'right') {
  const a = 8;
  let pts;
  if (dir === 'right') pts = `${x},${y} ${x - a * 1.6},${y - a} ${x - a * 1.6},${y + a}`;
  else if (dir === 'left') pts = `${x},${y} ${x + a * 1.6},${y - a} ${x + a * 1.6},${y + a}`;
  else if (dir === 'down') pts = `${x},${y} ${x - a},${y - a * 1.6} ${x + a},${y - a * 1.6}`;
  else pts = `${x},${y} ${x - a},${y + a * 1.6} ${x + a},${y + a * 1.6}`;
  return el('polygon', { points: pts, class: 'pipe-arrow' });
}

// Параметры системы координат мнемосхемы.
const VB_W = 900, VB_H = 600;
const NODE_W = 440, NODE_H = 170;
const WORKSHOP_W = 200, WORKSHOP_H = 92;
const ROWS = [115, 300, 485];

// Координатный план в зависимости от стороны магистрали (water → справа от ЦЕХА слева;
// drainage → магистраль справа от блоков, цеха слева).
function layoutFor(side) {
  if (side === 'left') {
    // Цеха слева, узлы учёта в центре, общая магистраль справа.
    const WORKSHOP_X = 40;
    const NODE_X     = WORKSHOP_X + WORKSHOP_W + 50; // 290
    const MAIN_X     = NODE_X + NODE_W + 130;        // 860
    return { side, MAIN_X, NODE_X, WORKSHOP_X };
  }
  // 'right' — магистраль слева, узлы в центре, цеха справа (схема водоснабжения).
  const MAIN_X     = 40;
  const NODE_X     = 170;
  const WORKSHOP_X = NODE_X + NODE_W + 50; // 660
  return { side, MAIN_X, NODE_X, WORKSHOP_X };
}

// Построение блока "узел учёта" в координатах (x0,y0) верхнего левого угла.
// theme: 'water' | 'drainage' — выбирает цветовую тему через CSS-классы.
function buildNode(idx, meter, x0, y0, theme = 'water', meterTitlePrefix = 'Счётчик № ', nodeLabel = 'УЗЕЛ УЧЁТА') {
  const g = el('g', { 'data-idx': idx, transform: `translate(${x0}, ${y0})`, class: `node-${theme}` });
  const W = NODE_W, H = NODE_H;

  // Штриховая рамка
  g.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, rx: 4, class: 'node-box' }));

  // Преобразователь интерфейса (Ethernet) сверху
  const cvX = 130, cvY = 6, cvW = 140, cvH = 28;
  g.appendChild(el('rect', { x: cvX, y: cvY, width: cvW, height: cvH, rx: 3, class: 'conv-box' }));
  g.appendChild(el('text', { x: cvX + cvW / 2, y: cvY + 12, 'text-anchor': 'middle', class: 'conv-label' }, 'Преобразователь'));
  g.appendChild(el('text', { x: cvX + cvW / 2, y: cvY + 23, 'text-anchor': 'middle', class: 'conv-label' }, theme === 'drainage' ? 'RS-232 ↔ Ethernet' : 'RS-485 ↔ Ethernet'));

  // IP-адрес и адрес/канал справа от преобразователя
  g.appendChild(el('text', { x: cvX + cvW + 6, y: cvY + 12, class: 'ip-text' }, `${meter.host}:${meter.port}`));
  const chanLabel = meter.channel ? `канал ${meter.channel}` : `адрес ${meter.device}`;
  g.appendChild(el('text', { x: cvX + cvW + 6, y: cvY + 24, class: 'ip-text' }, chanLabel));

  // Счётчик (коробка с объёмом и расходом)
  const cbX = 130, cbW = 180, cbY = 38, cbH = 84;
  // Оранжевая линия RS-485 между преобразователем и счётчиком
  g.appendChild(el('line', { x1: cvX + cvW / 2, y1: cvY + cvH, x2: cbX + cbW / 2, y2: cbY, class: 'eth-line' }));

  // Основная труба проходит горизонтально через центр счётчика
  const yPipe = cbY + cbH / 2;
  g.appendChild(el('line', { x1: 0, y1: yPipe, x2: W, y2: yPipe, class: 'pipe' }));

  // Задвижки на магистрали узла (только для водоснабжения)
  if (theme !== 'drainage') {
    g.appendChild(valve(60, yPipe));
    g.appendChild(valve(W - 60, yPipe));
  }

  // Коробка счётчика поверх трубы
  g.appendChild(el('rect', { x: cbX, y: cbY, width: cbW, height: cbH, rx: 3, class: 'counter-box' }));
  g.appendChild(el('text', { x: cbX + cbW / 2, y: cbY + 13, 'text-anchor': 'middle', class: 'counter-title' }, `${meterTitlePrefix}${meter.device}`));
  
  // Объём — большое значение с единицами измерения на той же строке
  g.appendChild(el('text', {
    x: cbX + cbW / 2, y: cbY + 40, 'text-anchor': 'middle', class: 'value-text', 'data-role': 'value',
  }, '— м³'));

  // Разделитель и расход м³/ч
  g.appendChild(el('line', {
    x1: cbX + 12, y1: cbY + 54, x2: cbX + cbW - 12, y2: cbY + 54,
    class: 'counter-sep',
  }));
  g.appendChild(el('text', {
    x: cbX + cbW / 2, y: cbY + 71, 'text-anchor': 'middle', class: 'flow-text', 'data-role': 'flow',
  }, '— м³/ч'));

  // Байпас — только для водоснабжения (колодец байпаса не имеет)
  if (theme !== 'drainage') {
    const byY = yPipe + 60;
    g.appendChild(el('path', {
      d: `M 36 ${yPipe} V ${byY} H ${W - 36} V ${yPipe}`,
      class: 'pipe',
    }));
    g.appendChild(valve(W / 2, byY, 12));
  }

  // Светодиод статуса (верх-право)
  g.appendChild(el('circle', { cx: W - 14, cy: 14, r: 7, class: 'led-circle idle', 'data-role': 'led' }));

  // Подпись типа узла в правом нижнем углу
  g.appendChild(el('text', { x: W - 8, y: H - 6, 'text-anchor': 'end', class: 'node-label' }, nodeLabel));

  // Статус / время опроса — слева снизу
  g.appendChild(el('text', { x: 8, y: H - 6, class: 'status-text', 'data-role': 'status' }, 'Ожидание опроса…'));

  return g;
}

// Построение всей мнемосхемы для указанного вида учёта (water/drainage).
function buildMnemonic(kind = 'water') {
  const k = KIND_CFG[kind];
  const svg = document.getElementById(k.svgId);
  if (!svg) return;
  svg.innerHTML = '';
  svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  // Класс на корне SVG позволяет CSS подменять цвета труб для дренажа.
  svg.setAttribute('class', `mnemonic-${k.theme}`);

  const list = getList(kind).slice(0, 3);
  while (list.length < 3) list.push({ name: k.fallbackName(list.length), host: '-', port: '-', device: '-', channel: 1 });

  const { side, MAIN_X, NODE_X, WORKSHOP_X } = layoutFor(k.side);

  // Заголовок
  svg.appendChild(el('text', {
    x: VB_W / 2, y: 15, 'text-anchor': 'middle',
    fill: '#111827', 'font-size': 15, 'font-weight': 700,
  }, k.title));

  // Вертикальная магистраль с подписью.
  const mainTop = 40, mainBottom = VB_H - 20;
  svg.appendChild(el('line', { x1: MAIN_X, y1: mainTop, x2: MAIN_X, y2: mainBottom, class: 'pipe' }));
  if (side === 'left') {
    // Водоотведение: стоки текут вниз по магистрали.
    svg.appendChild(arrowHead(MAIN_X, mainBottom + 5, 'down'));
  } else {
    // Водоснабжение: вода подаётся снизу вверх.
    svg.appendChild(arrowHead(MAIN_X, mainTop - 5, 'up'));
  }
  // Подпись магистрали слева для water (читается снизу вверх) и справа для drainage.
  const labelOffset = side === 'left' ? +16 : -16;
  svg.appendChild(el('text', {
    x: MAIN_X + labelOffset, y: (mainTop + mainBottom) / 2,
    transform: `rotate(-90 ${MAIN_X + labelOffset} ${(mainTop + mainBottom) / 2})`,
    'text-anchor': 'middle', class: 'flow-label',
  }, k.mainLabel));

  ROWS.forEach((y, i) => {
    const m = list[i];

    if (side === 'right') {
      // Магистраль → узел → цех (вода поступает в цех).
      svg.appendChild(el('line', { x1: MAIN_X, y1: y, x2: NODE_X, y2: y, class: 'pipe' }));
      svg.appendChild(el('text', { x: MAIN_X + 40, y: y - 6, class: 'flow-label' }, 'ДУ150'));
      svg.appendChild(arrowHead(NODE_X, y, 'right'));

      svg.appendChild(buildNode(i, m, NODE_X, y - 80, k.theme, k.meterTitlePrefix, k.nodeLabel));

      svg.appendChild(el('line', { x1: NODE_X + NODE_W, y1: y, x2: WORKSHOP_X, y2: y, class: 'pipe' }));
      svg.appendChild(arrowHead(WORKSHOP_X, y, 'right'));
      svg.appendChild(el('text', { x: NODE_X + NODE_W + 4, y: y - 6, class: 'flow-label' }, k.branchLabel));
    } else {
      // Цех → узел учёта (колодец) → магистраль (стоки уходят в общий сток).
      svg.appendChild(el('line', { x1: WORKSHOP_X + WORKSHOP_W, y1: y, x2: NODE_X, y2: y, class: 'pipe' }));
      svg.appendChild(el('text', { x: WORKSHOP_X + WORKSHOP_W + 4, y: y - 6, class: 'flow-label' }, k.branchLabel));
      svg.appendChild(arrowHead(NODE_X, y, 'right'));

      svg.appendChild(buildNode(i, m, NODE_X, y - 80, k.theme, k.meterTitlePrefix, k.nodeLabel));

      svg.appendChild(el('line', { x1: NODE_X + NODE_W, y1: y, x2: MAIN_X, y2: y, class: 'pipe' }));
      svg.appendChild(el('text', { x: NODE_X + NODE_W + 6, y: y - 6, class: 'flow-label' }, 'ДУ200'));
      svg.appendChild(arrowHead(MAIN_X, y, 'right'));
    }

    // Блок цеха со статистикой расхода.
    const wsTop = y - WORKSHOP_H / 2;
    const ws = el('g', { 'data-role': 'workshop', 'data-idx': i });
    ws.appendChild(el('rect', {
      x: WORKSHOP_X, y: wsTop, width: WORKSHOP_W, height: WORKSHOP_H, rx: 4, class: 'workshop-box',
    }));
    ws.appendChild(el('text', {
      x: WORKSHOP_X + WORKSHOP_W / 2, y: wsTop + 16,
      'text-anchor': 'middle', class: 'workshop-text',
    }, k.workshopWord));
    ws.appendChild(el('text', {
      x: WORKSHOP_X + WORKSHOP_W / 2, y: wsTop + 30,
      'text-anchor': 'middle', class: 'workshop-text',
    }, m.name || `ЦЕХ №${i + 1}`));

    ws.appendChild(el('line', {
      x1: WORKSHOP_X + 8, y1: wsTop + 40,
      x2: WORKSHOP_X + WORKSHOP_W - 8, y2: wsTop + 40,
      class: 'workshop-sep',
    }));
    ws.appendChild(el('text', { x: WORKSHOP_X + 10, y: wsTop + 56, class: 'usage-label' }, 'Сутки:'));
    ws.appendChild(el('text', {
      x: WORKSHOP_X + WORKSHOP_W - 10, y: wsTop + 56,
      'text-anchor': 'end', class: 'usage-value', 'data-role': 'day-usage',
    }, '— м³'));
    ws.appendChild(el('text', { x: WORKSHOP_X + 10, y: wsTop + 78, class: 'usage-label' }, 'Неделя:'));
    ws.appendChild(el('text', {
      x: WORKSHOP_X + WORKSHOP_W - 10, y: wsTop + 78,
      'text-anchor': 'end', class: 'usage-value', 'data-role': 'week-usage',
    }, '— м³'));
    ws.appendChild(el('text', {
      x: WORKSHOP_X + WORKSHOP_W / 2, y: wsTop + WORKSHOP_H - 4,
      'text-anchor': 'middle', class: 'usage-period', 'data-role': 'period-info',
    }, ''));
    svg.appendChild(ws);
  });
}

// Обновление индикаторов по последним результатам и возрасту данных.
function refreshIndicators(kind = 'water') {
  const k = KIND_CFG[kind];
  const svg = document.getElementById(k.svgId);
  if (!svg || !cfg) return;
  const pollMs = Math.max(1000, (Number(cfg.pollIntervalSec) || 30) * 1000);
  const now = Date.now();
  const list = getList(kind);
  const lastResultsArr = state[kind].lastResults;

  list.slice(0, 3).forEach((m, i) => {
    const node = svg.querySelector(`g[data-idx="${i}"]`);
    if (!node) return;
    const led = node.querySelector('[data-role="led"]');
    const val = node.querySelector('[data-role="value"]');
    const flowEl = node.querySelector('[data-role="flow"]');
    const st = node.querySelector('[data-role="status"]');
    const r = lastResultsArr[i];
    const enabled = m.enabled !== false;

    let ledState = 'idle';
    let statusText = enabled ? 'Ожидание опроса…' : 'Опрос отключён';

    if (!enabled) {
      ledState = 'idle';
      val.textContent = '— м³';
      if (flowEl) flowEl.textContent = '— м³/ч';
    } else if (r) {
      const age = now - new Date(r.timestamp).getTime();
      if (r.disabled) {
        ledState = 'idle';
        statusText = 'Опрос отключён';
        val.textContent = '— м³';
        if (flowEl) flowEl.textContent = '— м³/ч';
      } else if (!r.ok) {
        ledState = 'err';
        statusText = `Ошибка: ${r.error} · ${ageText(age)}`;
        val.textContent = '— м³';
        if (flowEl) flowEl.textContent = '— м³/ч';
      } else {
        ledState = age > pollMs * 2 ? 'stale' : 'ok';
        statusText = `Обновлено ${ageText(age)}`;
        val.textContent = `${fmtValue(r.value)} м³`;
        if (flowEl) flowEl.textContent = r.flow != null
          ? `${fmtFlow(r.flow)} м³/ч`
          : (r.flowError ? '⚠ м³/ч' : '— м³/ч');
      }
    } else {
      val.textContent = '— м³';
      if (flowEl) flowEl.textContent = '— м³/ч';
    }

    led.setAttribute('class', 'led-circle ' + ledState);
    st.textContent = statusText;

    // Применяем визуальное состояние "отключён" ко всему узлу, сохраняя тему.
    const baseClass = `node-${k.theme}`;
    node.setAttribute('class', enabled ? baseClass : `${baseClass} node-disabled`);

    // Расход за сутки/неделю — берём из последнего успешного результата или из снимка stats.
    const ws = svg.querySelector(`g[data-role="workshop"][data-idx="${i}"]`);
    if (ws) {
      const day = ws.querySelector('[data-role="day-usage"]');
      const week = ws.querySelector('[data-role="week-usage"]');
      const period = ws.querySelector('[data-role="period-info"]');
      const usage = pickUsage(kind, i);
      if (usage) {
        day.textContent  = `${fmtUsage(usage.dayUsage)} м³`;
        week.textContent = `${fmtUsage(usage.weekUsage)} м³`;
        // Время первого замера в текущем периоде; fallback — на формальное начало периода.
        const firstTs = usage.dayFirstTs || usage.dayStartTs;
        period.textContent = firstTs ? `с ${fmtPeriodStart(firstTs)}` : '';
      } else {
        day.textContent  = '— м³';
        week.textContent = '— м³';
        period.textContent = '';
      }
    }
  });
}

// Выбираем источник статистики для счётчика i указанного вида: сначала из последнего
// успешного poll-результата, иначе из снимка, полученного при старте.
function pickUsage(kind, i) {
  const s = state[kind];
  const r = s.lastResults[i];
  if (r && r.ok && r.dayUsage != null) return r;
  return s.statsSnapshots[i] || null;
}

function fmtUsage(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(1);
  if (a >= 100)  return v.toFixed(2);
  return v.toFixed(3);
}

function fmtFlow(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 10)  return v.toFixed(2);
  return v.toFixed(3);
}

function fmtPeriodStart(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${mi}`;
}

async function init() {
  cfg = await window.api.getConfig();
  buildMnemonic('water');
  buildMnemonic('drainage');
  renderSettings();
  await loadStatsSnapshots('water');
  await loadStatsSnapshots('drainage');
  refreshIndicators('water');
  refreshIndicators('drainage');
}

async function loadStatsSnapshots(kind) {
  const target = state[kind];
  try {
    const arr = kind === 'drainage'
      ? await window.api.getStatsDrainage()
      : await window.api.getStats();
    target.statsSnapshots = [null, null, null];
    arr.forEach((entry, idx) => {
      if (idx < 3 && entry && entry.snapshot) target.statsSnapshots[idx] = entry.snapshot;
    });
  } catch {
    target.statsSnapshots = [null, null, null];
  }
  // Поддерживаем обратно совместимые ссылки для тестового инжектора.
  if (kind === 'water') statsSnapshots = target.statsSnapshots;
}

function renderMeterRow(m, idx) {
  const tr = document.createElement('tr');
  const enabled = m.enabled !== false;
  const dayStartHour = Number.isFinite(m.dayStartHour) ? m.dayStartHour : 0;
  const weekStartDay = Number.isFinite(m.weekStartDay) ? m.weekStartDay : 1;
  tr.innerHTML = `
    <td class="cell-center"><input data-i="${idx}" data-k="enabled" type="checkbox" ${enabled ? 'checked' : ''}></td>
    <td><input data-i="${idx}" data-k="name" value="${escapeAttr(m.name || '')}"></td>
    <td><input data-i="${idx}" data-k="host" value="${escapeAttr(m.host || '')}"></td>
    <td><input data-i="${idx}" data-k="port" type="number" min="1" max="65535" value="${m.port || ''}"></td>
    <td><input data-i="${idx}" data-k="device" value="${escapeAttr(m.device || '')}"></td>
    <td><input data-i="${idx}" data-k="dayStartHour" type="number" min="0" max="23" value="${dayStartHour}"></td>
    <td><select data-i="${idx}" data-k="weekStartDay">
      ${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map((d, i) => `<option value="${i+1}" ${weekStartDay === i+1 ? 'selected' : ''}>${d}</option>`).join('')}
    </select></td>
  `;
  return tr;
}

function renderSettings() {
  document.getElementById('pollInterval').value = cfg.pollIntervalSec;
  document.getElementById('timeoutMs').value = cfg.timeoutMs;
  const tbody = document.getElementById('meters-body');
  tbody.innerHTML = '';
  cfg.meters.forEach((m, idx) => tbody.appendChild(renderMeterRow(m, idx)));
  const tbodyDrn = document.getElementById('drainage-meters-body');
  if (tbodyDrn) {
    tbodyDrn.innerHTML = '';
    (cfg.drainageMeters || []).forEach((m, idx) => tbodyDrn.appendChild(renderMeterRow(m, idx)));
  }
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const POLL_MIN = 10;
const POLL_MAX = 7200;

document.getElementById('settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const rawInterval = Number(document.getElementById('pollInterval').value);
  const intervalSec = Math.min(POLL_MAX, Math.max(POLL_MIN, Number.isFinite(rawInterval) ? Math.round(rawInterval) : 30));
  const newCfg = {
    pollIntervalSec: intervalSec,
    timeoutMs: Number(document.getElementById('timeoutMs').value) || 3000,
    meters: cfg.meters.map((m) => ({ ...m })),
    drainageMeters: (cfg.drainageMeters || []).map((m) => ({ ...m })),
  };
  const collect = (selector, listKey) => {
    document.querySelectorAll(selector).forEach((inp) => {
      const i = Number(inp.dataset.i);
      const k = inp.dataset.k;
      let v;
      if (inp.type === 'checkbox') v = inp.checked;
      else if (inp.type === 'number' || k === 'weekStartDay') v = Number(inp.value);
      else v = inp.value;
      if (newCfg[listKey][i]) newCfg[listKey][i][k] = v;
    });
  };
  collect('#meters-body input, #meters-body select', 'meters');
  collect('#drainage-meters-body input, #drainage-meters-body select', 'drainageMeters');
  // main.js может ещё подкорректировать интервал — берём его ответ как источник истины.
  const applied = await window.api.setConfig(newCfg);
  cfg = applied || newCfg;
  document.getElementById('pollInterval').value = cfg.pollIntervalSec;
  buildMnemonic('water');
  buildMnemonic('drainage');
  refreshIndicators('water');
  refreshIndicators('drainage');
  const s = document.getElementById('save-status');
  s.textContent = intervalSec !== rawInterval
    ? `Сохранено (период ограничен ${POLL_MIN}…${POLL_MAX} с)`
    : 'Сохранено';
  setTimeout(() => (s.textContent = ''), 3000);
});

document.getElementById('poll-now').addEventListener('click', () => {
  window.api.pollNow();
});

function applyPollResults(kind, results, lastPollLabelId) {
  if (!cfg) return;
  const target = state[kind];
  results.forEach((r) => {
    if (typeof r.idx !== 'number') return;
    target.lastResults[r.idx] = r;
    if (r.ok && r.dayUsage != null) {
      target.statsSnapshots[r.idx] = {
        lastValue: r.value,
        lastTs: r.timestamp,
        dayUsage: r.dayUsage,
        weekUsage: r.weekUsage,
        dayStartTs: r.dayStartTs,
        weekStartTs: r.weekStartTs,
        dayFirstTs: r.dayFirstTs,
        weekFirstTs: r.weekFirstTs,
      };
    }
  });
  refreshIndicators(kind);
  const lbl = document.getElementById(lastPollLabelId);
  if (lbl) lbl.textContent = `Последний опрос: ${new Date().toLocaleString('ru-RU')}`;
}

window.api.onPollResult((results)         => applyPollResults('water',    results, 'last-poll'));
window.api.onPollResultDrainage((results) => applyPollResults('drainage', results, 'last-poll-drainage'));

// Тик обновления "актуальности данных" без запроса к прибору — для обеих мнемосхем.
setInterval(() => { refreshIndicators('water'); refreshIndicators('drainage'); }, 1000);

// =========================================================
// Вкладка "Логи"
// =========================================================
const LOG_CAP = 1000;
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const logState = {
  entries: [],             // последние LOG_CAP записей (в памяти renderer)
  sources: new Set(),      // уникальные источники для фильтра
};

function fmtTs(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function lineMatchesFilter(entry) {
  const minLvl = document.getElementById('log-level-filter').value;
  const src = document.getElementById('log-source-filter').value;
  if (LEVEL_ORDER[entry.level] < LEVEL_ORDER[minLvl]) return false;
  if (src && entry.source !== src) return false;
  return true;
}

function makeLogLine(entry) {
  const line = document.createElement('div');
  line.className = 'log-line ' + entry.level;
  line.dataset.id = entry.id;
  line.innerHTML =
    `<span class="ts">${fmtTs(entry.ts)}</span>` +
    `<span class="lvl">${entry.level.toUpperCase()}</span>` +
    `<span class="src">[${escapeHtml(entry.source)}]</span>` +
    `<span class="msg"></span>`;
  line.querySelector('.msg').textContent = entry.msg;
  return line;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function refreshSourceFilter() {
  const sel = document.getElementById('log-source-filter');
  const current = sel.value;
  const sorted = [...logState.sources].sort();
  // Сохраняем "Все" + список источников.
  sel.innerHTML = '<option value="">Все</option>' +
    sorted.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  if (sorted.includes(current)) sel.value = current;
}

function rerenderLogs() {
  const view = document.getElementById('log-view');
  view.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const e of logState.entries) {
    if (!lineMatchesFilter(e)) continue;
    frag.appendChild(makeLogLine(e));
  }
  view.appendChild(frag);
  updateLogCount();
  scrollLogToBottomIfNeeded();
}

function updateLogCount() {
  document.getElementById('log-count').textContent =
    `Записей: ${logState.entries.length}${logState.entries.length >= LOG_CAP ? ' (макс.)' : ''}`;
}

function scrollLogToBottomIfNeeded() {
  const view = document.getElementById('log-view');
  if (document.getElementById('log-autoscroll').checked) {
    view.scrollTop = view.scrollHeight;
  }
}

let logEnabled = true;

function appendLogEntry(entry) {
  if (!logEnabled) return; // Приём логов в renderer приостановлен.
  logState.entries.push(entry);
  if (logState.entries.length > LOG_CAP) logState.entries.shift();

  let newSource = false;
  if (!logState.sources.has(entry.source)) {
    logState.sources.add(entry.source);
    newSource = true;
  }
  if (newSource) refreshSourceFilter();

  // Инкрементально добавляем строку в DOM, не перерисовывая всё.
  if (lineMatchesFilter(entry)) {
    const view = document.getElementById('log-view');
    view.appendChild(makeLogLine(entry));
    // Если в DOM больше строк, чем в буфере — подрезаем (на случай если entries уже обрезались).
    while (view.childElementCount > LOG_CAP) view.removeChild(view.firstChild);
    scrollLogToBottomIfNeeded();
  }
  updateLogCount();
}

async function initLogs() {
  const entries = await window.api.getLogs();
  logState.entries = entries.slice(-LOG_CAP);
  logState.sources = new Set(logState.entries.map((e) => e.source));
  refreshSourceFilter();
  rerenderLogs();
}

document.getElementById('log-level-filter').addEventListener('change', rerenderLogs);
document.getElementById('log-source-filter').addEventListener('change', rerenderLogs);
document.getElementById('log-autoscroll').addEventListener('change', scrollLogToBottomIfNeeded);
document.getElementById('log-enabled').addEventListener('change', (e) => {
  logEnabled = e.target.checked;
});
document.getElementById('log-clear').addEventListener('click', async () => {
  await window.api.clearLogs();
});

window.api.onLogAppend((entry) => appendLogEntry(entry));
window.api.onLogClear(() => {
  logState.entries = [];
  logState.sources = new Set();
  refreshSourceFilter();
  rerenderLogs();
});

// =========================================================
// Вкладка "Отчёты"
// =========================================================

let reportPeriod = '24h';

function renderReportSummary() {
  const el = document.getElementById('report-summary');
  if (!el || !cfg) return;

  let wDay = 0, wWeek = 0, dDay = 0, dWeek = 0;
  getList('water').forEach((_, i)    => { const u = pickUsage('water',    i); if (u) { wDay += u.dayUsage  || 0; wWeek += u.weekUsage  || 0; } });
  getList('drainage').forEach((_, i) => { const u = pickUsage('drainage', i); if (u) { dDay += u.dayUsage  || 0; dWeek += u.weekUsage  || 0; } });
  const lDay  = Math.max(0, wDay  - dDay);
  const lWeek = Math.max(0, wWeek - dWeek);

  el.innerHTML =
    `<div class="report-cards">
      <div class="report-card report-card-in">
        <div class="report-card-title">Входящая вода</div>
        <div class="report-card-row"><span>Сутки</span><strong>${fmtUsage(wDay)} м³</strong></div>
        <div class="report-card-row"><span>Неделя</span><strong>${fmtUsage(wWeek)} м³</strong></div>
      </div>
      <div class="report-card report-card-out">
        <div class="report-card-title">Исходящая вода</div>
        <div class="report-card-row"><span>Сутки</span><strong>${fmtUsage(dDay)} м³</strong></div>
        <div class="report-card-row"><span>Неделя</span><strong>${fmtUsage(dWeek)} м³</strong></div>
      </div>
      <div class="report-card report-card-loss">
        <div class="report-card-title">Потери на производстве</div>
        <div class="report-card-row"><span>Сутки</span><strong>${fmtUsage(lDay)} м³</strong></div>
        <div class="report-card-row"><span>Неделя</span><strong>${fmtUsage(lWeek)} м³</strong></div>
      </div>
    </div>`;
}

// Вычисляем дельты между последовательными часовыми записями в истории.
// Возвращает Map<hourISO, delta> — потребление за каждый час.
function computeHourlyDeltas(history) {
  const map = new Map();
  for (let i = 1; i < history.length; i++) {
    map.set(history[i].hour, Math.max(0, history[i].value - history[i - 1].value));
  }
  return map;
}

function buildHistoryTable(wList, dList) {
  const allMeters = [...wList, ...dList];
  if (allMeters.every(m => m.history.length === 0)) {
    return '<p class="report-empty">История пуста — данных ещё нет.</p>';
  }
  return reportPeriod === '24h'
    ? buildHourlyTable(wList, dList)
    : buildDailyTable(wList, dList);
}

function buildHourlyTable(wList, dList) {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  cutoff.setMinutes(0, 0, 0);
  const cutoffIso = cutoff.toISOString();

  const hoursSet = new Set();
  [...wList, ...dList].forEach(m => m.history.forEach(e => { if (e.hour >= cutoffIso) hoursSet.add(e.hour); }));
  if (hoursSet.size === 0) return '<p class="report-empty">Нет данных за последние 24 часа.</p>';

  const hours    = [...hoursSet].sort();
  const wDeltas  = wList.map(m => computeHourlyDeltas(m.history));
  const dDeltas  = dList.map(m => computeHourlyDeltas(m.history));

  let html = '<table class="report-table report-table-history"><thead><tr><th>Час</th>';
  wList.forEach(m => { const n = m.name || `Цех ${m.idx + 1}`;    html += `<th title="${escapeHtml(n)}">${escapeHtml(n)}</th>`; });
  dList.forEach(m => { const n = m.name || `Кол. ${m.idx + 1}`; html += `<th title="${escapeHtml(n)}">${escapeHtml(n)}</th>`; });
  html += '<th>Σ Вход</th><th>Σ Выход</th><th>Потери</th></tr></thead><tbody>';

  hours.forEach(hour => {
    const d = new Date(hour);
    const lbl = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`;
    html += `<tr><td class="report-ts">${lbl}</td>`;
    let wSum = 0, dSum = 0, hasW = false, hasD = false;
    wList.forEach((_, i) => { const v = wDeltas[i].get(hour); html += `<td class="report-num report-water">${v != null ? fmtUsage(v) : '—'}</td>`; if (v != null) { wSum += v; hasW = true; } });
    dList.forEach((_, i) => { const v = dDeltas[i].get(hour); html += `<td class="report-num report-drain">${v != null ? fmtUsage(v) : '—'}</td>`; if (v != null) { dSum += v; hasD = true; } });
    html += `<td class="report-num report-water"><strong>${hasW ? fmtUsage(wSum) : '—'}</strong></td>`;
    html += `<td class="report-num report-drain"><strong>${hasD ? fmtUsage(dSum) : '—'}</strong></td>`;
    html += `<td class="report-num report-loss"><strong>${(hasW && hasD) ? fmtUsage(Math.max(0, wSum - dSum)) : '—'}</strong></td></tr>`;
  });
  html += '</tbody></table>';
  return html;
}

function buildDailyTable(wList, dList) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 7);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  const computeDailyMap = (history) => {
    const days = new Map();
    computeHourlyDeltas(history).forEach((delta, hour) => {
      const day = hour.slice(0, 10);
      days.set(day, (days.get(day) || 0) + delta);
    });
    return days;
  };

  const wDays = wList.map(m => computeDailyMap(m.history));
  const dDays = dList.map(m => computeDailyMap(m.history));

  const datesSet = new Set();
  [...wDays, ...dDays].forEach(map => map.forEach((_, d) => { if (d >= cutoffStr) datesSet.add(d); }));
  if (datesSet.size === 0) return '<p class="report-empty">Нет данных за последние 7 дней.</p>';

  const dates = [...datesSet].sort();

  let html = '<table class="report-table report-table-history"><thead><tr><th>Дата</th>';
  wList.forEach(m => { const n = m.name || `Цех ${m.idx + 1}`;    html += `<th title="${escapeHtml(n)}">${escapeHtml(n)}</th>`; });
  dList.forEach(m => { const n = m.name || `Кол. ${m.idx + 1}`; html += `<th title="${escapeHtml(n)}">${escapeHtml(n)}</th>`; });
  html += '<th>Σ Вход</th><th>Σ Выход</th><th>Потери</th></tr></thead><tbody>';

  let wGrand = 0, dGrand = 0;
  dates.forEach(date => {
    const [y, mo, d] = date.split('-');
    html += `<tr><td class="report-ts">${d}.${mo}.${y}</td>`;
    let wSum = 0, dSum = 0, hasW = false, hasD = false;
    wList.forEach((_, i) => { const v = wDays[i].get(date); html += `<td class="report-num report-water">${v != null ? fmtUsage(v) : '—'}</td>`; if (v != null) { wSum += v; hasW = true; } });
    dList.forEach((_, i) => { const v = dDays[i].get(date); html += `<td class="report-num report-drain">${v != null ? fmtUsage(v) : '—'}</td>`; if (v != null) { dSum += v; hasD = true; } });
    html += `<td class="report-num report-water"><strong>${hasW ? fmtUsage(wSum) : '—'}</strong></td>`;
    html += `<td class="report-num report-drain"><strong>${hasD ? fmtUsage(dSum) : '—'}</strong></td>`;
    html += `<td class="report-num report-loss"><strong>${(hasW && hasD) ? fmtUsage(Math.max(0, wSum - dSum)) : '—'}</strong></td></tr>`;
    wGrand += wSum; dGrand += dSum;
  });

  const grandLoss = Math.max(0, wGrand - dGrand);
  const emptyCols = [...wList, ...dList].map(() => '<td></td>').join('');
  html += `<tr class="report-row-total"><td><strong>За период</strong></td>${emptyCols}
    <td class="report-num"><strong>${fmtUsage(wGrand)}</strong></td>
    <td class="report-num"><strong>${fmtUsage(dGrand)}</strong></td>
    <td class="report-num report-loss"><strong>${fmtUsage(grandLoss)}</strong></td></tr>`;
  html += '</tbody></table>';
  return html;
}

async function renderReportDetail() {
  const el = document.getElementById('report-detail');
  if (!el) return;

  let histData;
  try { histData = await window.api.getStatsHistory(); }
  catch { histData = { water: [], drainage: [] }; }

  const wList = histData.water    || [];
  const dList = histData.drainage || [];

  let meterRows = '';
  let wDayTot = 0, wWeekTot = 0, dDayTot = 0, dWeekTot = 0;

  const buildRow = (m, kind) => {
    const isW  = kind === 'water';
    const name = m.name || (isW ? `Цех ${m.idx + 1}` : `Колодец ${m.idx + 1}`);
    const u    = pickUsage(kind, m.idx);
    const dayV = u ? fmtUsage(u.dayUsage)  : '—';
    const wkV  = u ? fmtUsage(u.weekUsage) : '—';
    const val  = m.lastValue != null ? fmtValue(m.lastValue) : '—';
    const ts   = m.lastTs ? new Date(m.lastTs).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';
    if (isW && u) { wDayTot += u.dayUsage || 0; wWeekTot += u.weekUsage || 0; }
    else if (!isW && u) { dDayTot += u.dayUsage || 0; dWeekTot += u.weekUsage || 0; }
    return `<tr class="${isW ? 'report-row-water' : 'report-row-drain'}">
      <td>${escapeHtml(name)}</td><td>${isW ? 'Вход' : 'Выход'}</td>
      <td class="report-num">${val}</td>
      <td class="report-num ${isW ? 'report-water' : 'report-drain'}">${dayV}</td>
      <td class="report-num ${isW ? 'report-water' : 'report-drain'}">${wkV}</td>
      <td class="report-ts">${ts}</td></tr>`;
  };

  wList.forEach(m => { meterRows += buildRow(m, 'water'); });
  dList.forEach(m => { meterRows += buildRow(m, 'drainage'); });

  const lossDay = Math.max(0, wDayTot - dDayTot), lossWeek = Math.max(0, wWeekTot - dWeekTot);
  meterRows += `<tr class="report-row-total"><td colspan="2"><strong>Итого вход</strong></td><td></td>
    <td class="report-num report-water"><strong>${fmtUsage(wDayTot)}</strong></td>
    <td class="report-num report-water"><strong>${fmtUsage(wWeekTot)}</strong></td><td></td></tr>
    <tr class="report-row-total"><td colspan="2"><strong>Итого выход</strong></td><td></td>
    <td class="report-num report-drain"><strong>${fmtUsage(dDayTot)}</strong></td>
    <td class="report-num report-drain"><strong>${fmtUsage(dWeekTot)}</strong></td><td></td></tr>
    <tr class="report-row-loss"><td colspan="2"><strong>Потери</strong></td><td></td>
    <td class="report-num report-loss"><strong>${fmtUsage(lossDay)}</strong></td>
    <td class="report-num report-loss"><strong>${fmtUsage(lossWeek)}</strong></td><td></td></tr>`;

  const histHtml = buildHistoryTable(wList, dList);
  const p24 = reportPeriod === '24h' ? ' active' : '';
  const p7d = reportPeriod === '7d'  ? ' active' : '';

  el.innerHTML =
    `<div class="report-section">
      <h3 class="report-section-title">Показатели по счётчикам</h3>
      <div class="report-table-wrap">
        <table class="report-table">
          <thead><tr><th>Счётчик</th><th>Тип</th><th>Показание, м³</th><th>Расход, сутки</th><th>Расход, неделя</th><th>Время опроса</th></tr></thead>
          <tbody>${meterRows}</tbody>
        </table>
      </div>
    </div>
    <div class="report-section">
      <div class="report-hist-toolbar">
        <h3 class="report-section-title">История потребления (м³/период)</h3>
        <div class="report-period-btns">
          <button class="btn-secondary report-period-btn${p24}" data-period="24h">24 часа</button>
          <button class="btn-secondary report-period-btn${p7d}" data-period="7d">7 дней</button>
        </div>
        <button class="btn-secondary" id="report-refresh-btn">↺ Обновить</button>
      </div>
      <div class="report-table-wrap">${histHtml}</div>
    </div>`;

  el.querySelectorAll('.report-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      reportPeriod = btn.dataset.period;
      renderReportDetail();
    });
  });
  document.getElementById('report-refresh-btn')?.addEventListener('click', () => renderReportDetail());
}

async function renderReports() {
  if (!cfg) return;
  renderReportSummary();
  await renderReportDetail();
}

document.querySelector('.tab[data-tab="reports"]')?.addEventListener('click', () => renderReports());

function csvRow(...cells) {
  return cells.map(c => {
    const s = String(c ?? '');
    return s.includes(';') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';');
}

async function generateReportCsv() {
  let histData;
  try { histData = await window.api.getStatsHistory(); }
  catch { histData = { water: [], drainage: [] }; }

  const wList = histData.water    || [];
  const dList = histData.drainage || [];
  const now   = new Date();
  const nowStr = `${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${now.getFullYear()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const lines = [];
  lines.push(csvRow('ОТЧЁТ PULSAR MONITOR'));
  lines.push(csvRow(`Дата формирования: ${nowStr}`));
  lines.push('');

  // Сводка
  let wDay = 0, wWeek = 0, dDay = 0, dWeek = 0;
  getList('water').forEach((_, i)    => { const u = pickUsage('water',    i); if (u) { wDay += u.dayUsage || 0; wWeek += u.weekUsage || 0; } });
  getList('drainage').forEach((_, i) => { const u = pickUsage('drainage', i); if (u) { dDay += u.dayUsage || 0; dWeek += u.weekUsage || 0; } });
  lines.push(csvRow('СВОДКА', '', 'Сутки (м³)', 'Неделя (м³)'));
  lines.push(csvRow('Входящая вода',         '', fmtUsage(wDay),                  fmtUsage(wWeek)));
  lines.push(csvRow('Исходящая вода',        '', fmtUsage(dDay),                  fmtUsage(dWeek)));
  lines.push(csvRow('Потери на производстве','', fmtUsage(Math.max(0,wDay-dDay)), fmtUsage(Math.max(0,wWeek-dWeek))));
  lines.push('');

  // Таблица по счётчикам
  lines.push(csvRow('ПОКАЗАТЕЛИ ПО СЧЁТЧИКАМ'));
  lines.push(csvRow('Счётчик', 'Тип', 'Показание (м³)', 'Расход сутки (м³)', 'Расход неделя (м³)', 'Время опроса'));
  const pushMeterRow = (m, kind) => {
    const isW  = kind === 'water';
    const name = m.name || (isW ? `Цех ${m.idx + 1}` : `Колодец ${m.idx + 1}`);
    const u    = pickUsage(kind, m.idx);
    const ts   = m.lastTs ? new Date(m.lastTs).toLocaleString('ru-RU') : '—';
    lines.push(csvRow(name, isW ? 'Вход' : 'Выход', m.lastValue != null ? fmtValue(m.lastValue) : '—', u ? fmtUsage(u.dayUsage) : '—', u ? fmtUsage(u.weekUsage) : '—', ts));
  };
  wList.forEach(m => pushMeterRow(m, 'water'));
  dList.forEach(m => pushMeterRow(m, 'drainage'));
  lines.push('');

  // История потребления
  const periodLabel = reportPeriod === '24h' ? 'последние 24 часа' : 'последние 7 дней';
  lines.push(csvRow(`ИСТОРИЯ ПОТРЕБЛЕНИЯ (${periodLabel}, м³/период)`));
  const periodCol  = reportPeriod === '24h' ? 'Час' : 'Дата';
  const meterCols  = [...wList.map(m => m.name || `Цех ${m.idx+1}`), ...dList.map(m => m.name || `Кол. ${m.idx+1}`)];
  lines.push(csvRow(periodCol, ...meterCols, 'Σ Вход', 'Σ Выход', 'Потери'));

  if (reportPeriod === '24h') {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000); cutoff.setMinutes(0,0,0);
    const cutoffIso = cutoff.toISOString();
    const hoursSet  = new Set();
    [...wList, ...dList].forEach(m => m.history.forEach(e => { if (e.hour >= cutoffIso) hoursSet.add(e.hour); }));
    const wDeltas   = wList.map(m => computeHourlyDeltas(m.history));
    const dDeltas   = dList.map(m => computeHourlyDeltas(m.history));
    [...hoursSet].sort().forEach(hour => {
      const d   = new Date(hour);
      const lbl = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`;
      let wSum = 0, dSum = 0, hasW = false, hasD = false;
      const vals = [];
      wList.forEach((_, i) => { const v = wDeltas[i].get(hour); vals.push(v != null ? fmtUsage(v) : ''); if (v != null) { wSum += v; hasW = true; } });
      dList.forEach((_, i) => { const v = dDeltas[i].get(hour); vals.push(v != null ? fmtUsage(v) : ''); if (v != null) { dSum += v; hasD = true; } });
      lines.push(csvRow(lbl, ...vals, hasW ? fmtUsage(wSum) : '', hasD ? fmtUsage(dSum) : '', (hasW && hasD) ? fmtUsage(Math.max(0, wSum-dSum)) : ''));
    });
  } else {
    const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - 7);
    const cutoffStr  = cutoffDate.toISOString().slice(0, 10);
    const computeDailyMap = (history) => { const days = new Map(); computeHourlyDeltas(history).forEach((delta, hour) => { const day = hour.slice(0,10); days.set(day,(days.get(day)||0)+delta); }); return days; };
    const wDays = wList.map(m => computeDailyMap(m.history));
    const dDays = dList.map(m => computeDailyMap(m.history));
    const datesSet = new Set();
    [...wDays, ...dDays].forEach(map => map.forEach((_,d) => { if (d >= cutoffStr) datesSet.add(d); }));
    let wGrand = 0, dGrand = 0;
    [...datesSet].sort().forEach(date => {
      const [y,mo,d] = date.split('-');
      let wSum = 0, dSum = 0, hasW = false, hasD = false;
      const vals = [];
      wList.forEach((_,i) => { const v = wDays[i].get(date); vals.push(v != null ? fmtUsage(v) : ''); if (v != null) { wSum += v; hasW = true; } });
      dList.forEach((_,i) => { const v = dDays[i].get(date); vals.push(v != null ? fmtUsage(v) : ''); if (v != null) { dSum += v; hasD = true; } });
      lines.push(csvRow(`${d}.${mo}.${y}`, ...vals, hasW ? fmtUsage(wSum) : '', hasD ? fmtUsage(dSum) : '', (hasW&&hasD) ? fmtUsage(Math.max(0,wSum-dSum)) : ''));
      wGrand += wSum; dGrand += dSum;
    });
    const empties = [...wList, ...dList].map(() => '');
    lines.push(csvRow('За период', ...empties, fmtUsage(wGrand), fmtUsage(dGrand), fmtUsage(Math.max(0, wGrand-dGrand))));
  }

  // UTF-8 BOM для корректного открытия в Excel
  return '\uFEFF' + lines.join('\r\n');
}

document.getElementById('report-export-btn')?.addEventListener('click', async () => {
  const btn    = document.getElementById('report-export-btn');
  const status = document.getElementById('report-export-status');
  btn.disabled = true;
  status.textContent = 'Формирование…';
  try {
    const csv  = await generateReportCsv();
    const date = new Date();
    const name = `pulsar_report_${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}.csv`;
    const res  = await window.api.saveReport(csv, name);
    if (res.ok) {
      status.textContent = `Сохранён: ${res.filePath}`;
    } else {
      status.textContent = res.error ? `Ошибка: ${res.error}` : 'Отменено';
    }
  } catch (e) {
    status.textContent = `Ошибка: ${e.message}`;
  } finally {
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 6000);
  }
});

// Версия приложения в вкладке «О программе».
async function loadAboutInfo() {
  try {
    const v = await window.api.getVersion();
    const el = document.getElementById('about-version');
    if (el && v) el.textContent = v;
  } catch { /* некритично */ }
}

init();
initLogs();
loadAboutInfo();
