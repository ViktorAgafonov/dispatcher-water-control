'use strict';

// Учёт суточного и недельного расхода для каждого счётчика.
//
// Алгоритм: при первом успешном опросе после начала нового периода (суток/недели)
// фиксируем текущее показание как baseValue этого периода. Расход = текущее - baseValue.
//
// "Сутки" начинаются в час dayStartHour (0..23) каждого дня.
// "Неделя" начинается в день weekStartDay (1=Пн..7=Вс по ISO) в час dayStartHour.

const fs = require('fs');
const path = require('path');

class StatsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { meters: {} };
    this._dirty = false;
    this._writeTimer = null;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.meters) {
        this.data = parsed;
      }
    } catch {
      // Файла нет / повреждён — стартуем с пустыми данными.
    }
  }

  _scheduleWrite() {
    this._dirty = true;
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => this.flush(), 1500);
  }

  flush() {
    if (this._writeTimer) { clearTimeout(this._writeTimer); this._writeTimer = null; }
    if (!this._dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
      this._dirty = false;
    } catch {
      // Не критично: статистика не сохранится, но приложение работает.
    }
  }

  // Уникальный ключ счётчика (не зависит от порядка в списке).
  // Для счётчиков дренажа добавляется префикс «drn:», чтобы не пересекаться
  // с водомерами Пульсар при совпадении host:port:device.
  static keyOf(meter) {
    const prefix = meter.kind === 'drainage' ? 'drn:' : '';
    return `${prefix}${meter.device}@${meter.host}:${meter.port}/${meter.channel || 1}`;
  }

  // Начало текущих суток для счётчика (Date в локальном времени).
  static dayStart(now, dayStartHour) {
    const h = Number(dayStartHour) || 0;
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
    return d;
  }

  // Начало текущей недели для счётчика. weekStartDay: 1=Пн..7=Вс.
  static weekStart(now, dayStartHour, weekStartDay) {
    const target = ((Number(weekStartDay) || 1) - 1) % 7; // 0=Пн..6=Вс — внутренняя индексация
    const ds = StatsStore.dayStart(now, dayStartHour);
    // JS Date.getDay(): 0=Вс,1=Пн,..6=Сб → переводим в 0=Пн..6=Вс.
    const isoIdx = (ds.getDay() + 6) % 7;
    let diff = isoIdx - target;
    if (diff < 0) diff += 7;
    const r = new Date(ds);
    r.setDate(ds.getDate() - diff);
    return r;
  }

  // Поиск в истории показаний последнего замера, сделанного НЕ ПОЗЖЕ заданного момента.
  // Используется при пересечении границы периода (суток/недели), чтобы корректно
  // вычислять расход даже если программа в этот момент была выключена.
  static _findBaselineAtOrBefore(history, periodStartMs) {
    if (!Array.isArray(history) || history.length === 0) return null;
    let best = null;
    for (const e of history) {
      const t = new Date(e.ts).getTime();
      if (t <= periodStartMs) best = e;
      else break; // история отсортирована по возрастанию времени
    }
    return best;
  }

  // Размер кольцевого буфера почасовой истории: ~8 суток.
  static get HISTORY_CAP() { return 192; }

  // Регистрируем успешный замер. Возвращает usage с доп. метаданными.
  record(meter, value, ts) {
    const key = StatsStore.keyOf(meter);
    const now = ts ? new Date(ts) : new Date();
    const nowMs = now.getTime();
    const ds = StatsStore.dayStart(now, meter.dayStartHour);
    const ws = StatsStore.weekStart(now, meter.dayStartHour, meter.weekStartDay);

    let m = this.data.meters[key];
    if (!m) {
      m = this.data.meters[key] = { lastValue: null, lastTs: null, day: null, week: null, history: [] };
    }
    if (!Array.isArray(m.history)) m.history = [];

    const dayStartIso = ds.toISOString();
    const weekStartIso = ws.toISOString();
    const dayStartMs = ds.getTime();
    const weekStartMs = ws.getTime();
    const nowIso = now.toISOString();

    // Инициализация / переход через границу суток.
    if (!m.day || m.day.startTs !== dayStartIso) {
      // Сначала пробуем взять baseline из истории (последний замер до начала периода).
      const histBase = StatsStore._findBaselineAtOrBefore(m.history, dayStartMs);
      const baseValue = histBase ? histBase.value : (m.lastValue != null ? m.lastValue : value);
      m.day = { startTs: dayStartIso, baseValue, firstTs: nowIso };
    }
    // Аналогично для недели.
    if (!m.week || m.week.startTs !== weekStartIso) {
      const histBase = StatsStore._findBaselineAtOrBefore(m.history, weekStartMs);
      const baseValue = histBase ? histBase.value : (m.lastValue != null ? m.lastValue : value);
      m.week = { startTs: weekStartIso, baseValue, firstTs: nowIso };
    }

    // Дописываем в почасовую историю: одна запись на час (последняя в часе перезаписывается).
    const hourTop = new Date(nowMs); hourTop.setMinutes(0, 0, 0);
    const hourIso = hourTop.toISOString();
    if (m.history.length && m.history[m.history.length - 1].hour === hourIso) {
      m.history[m.history.length - 1] = { hour: hourIso, ts: nowIso, value };
    } else {
      m.history.push({ hour: hourIso, ts: nowIso, value });
      const cap = StatsStore.HISTORY_CAP;
      if (m.history.length > cap) m.history.splice(0, m.history.length - cap);
    }

    m.lastValue = value;
    m.lastTs = nowIso;
    this._scheduleWrite();

    return {
      dayUsage: Math.max(0, value - m.day.baseValue),
      weekUsage: Math.max(0, value - m.week.baseValue),
      dayStartTs: m.day.startTs,
      weekStartTs: m.week.startTs,
      dayFirstTs: m.day.firstTs,
      weekFirstTs: m.week.firstTs,
    };
  }

  // Текущая статистика без записи (для UI).
  snapshot(meter) {
    const key = StatsStore.keyOf(meter);
    const m = this.data.meters[key];
    if (!m || m.lastValue == null) return null;
    return {
      lastValue: m.lastValue,
      lastTs: m.lastTs,
      dayUsage: m.day ? Math.max(0, m.lastValue - m.day.baseValue) : 0,
      weekUsage: m.week ? Math.max(0, m.lastValue - m.week.baseValue) : 0,
      dayStartTs: m.day ? m.day.startTs : null,
      weekStartTs: m.week ? m.week.startTs : null,
      dayFirstTs: m.day ? m.day.firstTs : null,
      weekFirstTs: m.week ? m.week.firstTs : null,
    };
  }

  // Удалить хранилище для счётчиков, которых больше нет в конфиге.
  prune(activeKeys) {
    const set = new Set(activeKeys);
    let changed = false;
    for (const k of Object.keys(this.data.meters)) {
      if (!set.has(k)) { delete this.data.meters[k]; changed = true; }
    }
    if (changed) this._scheduleWrite();
  }
}

module.exports = { StatsStore };
