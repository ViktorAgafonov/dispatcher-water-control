'use strict';

// Кольцевой буфер логов + эмиттер событий. Используется в main-процессе.

const { EventEmitter } = require('events');

const CAPACITY = 1000;

class Logger extends EventEmitter {
  constructor(cap = CAPACITY) {
    super();
    this.setMaxListeners(20);
    this.cap = cap;
    this.buf = [];
    this.seq = 0;
  }

  log(level, source, msg, meta) {
    const entry = {
      id: ++this.seq,
      ts: Date.now(),
      level,                 // 'debug' | 'info' | 'warn' | 'error'
      source: source || '-', // например, имя счётчика или 'app'
      msg: String(msg),
      meta: meta || null,    // опционально: { hex, bytes, ... }
    };
    this.buf.push(entry);
    if (this.buf.length > this.cap) this.buf.shift();
    this.emit('entry', entry);
    return entry;
  }

  debug(source, msg, meta) { return this.log('debug', source, msg, meta); }
  info(source, msg, meta)  { return this.log('info',  source, msg, meta); }
  warn(source, msg, meta)  { return this.log('warn',  source, msg, meta); }
  error(source, msg, meta) { return this.log('error', source, msg, meta); }

  all() { return this.buf.slice(); }
  clear() { this.buf = []; this.emit('clear'); }
}

// Глобальный синглтон на процесс.
module.exports = new Logger(CAPACITY);
module.exports.CAPACITY = CAPACITY;
