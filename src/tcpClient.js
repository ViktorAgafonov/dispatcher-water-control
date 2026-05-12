'use strict';

// TCP-клиент с таймаутом для одиночного запроса/ответа Пульсар.
// Логирует: коннект, TX/RX hex, ошибки, таймауты.

const net = require('net');
const logger = require('./logger');

function hex(buf) {
  return buf.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ');
}

function request(host, port, packet, { timeoutMs = 3000, expectedLen, tag = 'tcp' } = {}) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const chunks = [];
    let done = false;
    let connectedAt = 0;
    let receivedOk = false; // получили валидный ответ — закрытие после этого штатное.

    const closeSocket = (reason) => {
      if (sock.destroyed) return;
      const lifeMs = connectedAt ? Date.now() - connectedAt : 0;
      logger.debug(tag, `Отключение ${host}:${port} (${reason}, сессия ${lifeMs} мс)`);
      try { sock.destroy(); } catch {}
    };

    const finish = (err, data, reason) => {
      if (done) return;
      done = true;
      closeSocket(reason || (err ? err.message : 'ok'));
      if (err) reject(err); else resolve(data);
    };

    const timer = setTimeout(() => {
      logger.warn(tag, `Таймаут ответа ${host}:${port} (${timeoutMs} мс)`);
      finish(new Error('Таймаут ответа'), null, 'таймаут');
    }, timeoutMs);

    sock.once('error', (e) => {
      clearTimeout(timer);
      logger.error(tag, `TCP ошибка ${host}:${port}: ${e.message}`);
      finish(e, null, `ошибка: ${e.message}`);
    });
    sock.once('end', () => {
      // Удалённая сторона закрыла свой конец — нормально для one-shot конвертеров.
      logger.debug(tag, `Удалённая сторона закрыла соединение ${host}:${port}`);
    });
    sock.once('close', (hadError) => {
      clearTimeout(timer);
      if (done) return;
      const buf = Buffer.concat(chunks);
      if (buf.length > 0 && !receivedOk) {
        // Соединение закрыто, ответ не успел собраться по длине L — пробуем как есть.
        logger.debug(tag, `RX [${buf.length} байт] ${hex(buf)}`);
        finish(null, buf, 'закрыто с частичным ответом');
      } else if (!receivedOk) {
        finish(new Error(hadError ? 'Соединение закрыто с ошибкой' : 'Соединение закрыто без данных'), null, 'закрыто без данных');
      }
    });

    sock.on('data', (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      // Если длина указана в байте L (6-й) — только для протокола Пульсар (без expectedLen).
      if (!expectedLen && buf.length >= 6) {
        const L = buf[5];
        if (buf.length >= L) {
          clearTimeout(timer);
          const resp = buf.slice(0, L);
          logger.debug(tag, `RX [${resp.length} байт] ${hex(resp)}`);
          receivedOk = true;
          finish(null, resp, 'ответ получен');
          return;
        }
      }
      if (expectedLen && buf.length >= expectedLen) {
        clearTimeout(timer);
        const resp = buf.slice(0, expectedLen);
        logger.debug(tag, `RX [${resp.length} байт] ${hex(resp)}`);
        receivedOk = true;
        finish(null, resp, 'ответ получен');
      }
    });

    sock.connect(port, host, () => {
      connectedAt = Date.now();
      logger.info(tag, `Подключено ${host}:${port}`);
      logger.debug(tag, `TX [${packet.length} байт] ${hex(packet)}`);
      sock.write(packet);
    });
  });
}

module.exports = { request };
