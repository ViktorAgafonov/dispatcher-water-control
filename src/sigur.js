'use strict';

// Протокол счётчиков «Эхо Сигнур» (ЭХО-Р-03-x) — Modbus RTU over TCP.
// Запрос: fn=0x03, регистры 0..9 (count=10), старт=0x0000.
// Пакет: [addr, 0x03, 0x00, 0x00, 0x00, 0x0A, CRC_lo, CRC_hi] — 8 байт.
//
// Ответ (25 байт — стандартный Modbus с byteCount):
//  0:      адрес
//  1:      0x03
//  2:      byteCount = 0x14 (20 байт = 10 рег × 2)
//  3..6:   уровень H, float32 LE [м]        (рег 0..1)
//  7..10:  расход Q, float32 LE [м³/с]      (рег 2..3) → ×3600 = м³/ч
//  11..14: сумм. объём raw, int32 LE        (рег 4..5)
//  15..18: время учёта, uint32 LE [мин]     (рег 6..7)
//  19..20: (зарезервировано)                (рег 8)
//  21..22: PU, int16 LE; объём_м3 = raw × 10^(PU-3) (рег 9)
//  23..24: CRC16-Modbus LE

function crc16Modbus(buf) {
  let w = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    w ^= buf[i];
    for (let s = 0; s < 8; s++) {
      const f = w & 1;
      w >>>= 1;
      if (f) w ^= 0xA001;
    }
  }
  return w & 0xFFFF;
}

function appendCrc(packet) {
  const crc = crc16Modbus(packet);
  const out = Buffer.alloc(packet.length + 2);
  packet.copy(out, 0);
  out.writeUInt16LE(crc, packet.length);
  return out;
}

function checkCrc(buf) {
  if (buf.length < 4) return false;
  const expected = buf.readUInt16LE(buf.length - 2);
  const actual = crc16Modbus(buf.slice(0, buf.length - 2));
  return expected === actual;
}

// fn=0x03, регистры 0..9 — читает текущие измерения (10 регистров).
function buildReadCurrentRequest(addr) {
  const a = Number(addr);
  if (!Number.isInteger(a) || a < 1 || a > 247) {
    throw new Error(`Некорректный адрес прибора Сигнур: ${addr}`);
  }
  const head = Buffer.from([a & 0xFF, 0x03, 0x00, 0x00, 0x00, 0x0A]);
  return appendCrc(head);
}

// Разбор ответа fn=0x03 (25 байт). Возвращает { volume (м³), flow (м³/ч), level (м), accTime (мин) }.
function parseReadCurrentResponse(resp, addr) {
  if (!Buffer.isBuffer(resp)) throw new Error('Ответ Сигнур: ожидался Buffer');
  if (resp.length < 23) throw new Error(`Ответ Сигнур: слишком короткий (${resp.length} байт)`);
  if (resp[0] !== (Number(addr) & 0xFF)) {
    throw new Error(`Ответ Сигнур: адрес ${resp[0]} не совпадает с запрошенным ${addr}`);
  }
  if (resp[1] !== 0x03) {
    if (resp[1] === 0x83) {
      const e = new Error(`Ответ Сигнур: ошибка Modbus (код исключения 0x${resp[2]?.toString(16)})`);
      e.deviceErrorCode = resp[2];
      throw e;
    }
    throw new Error(`Ответ Сигнур: неожиданный код функции 0x${resp[1].toString(16)}`);
  }
  // resp[2] = byteCount (ожидается 0x14 = 20), данные начинаются с [3]
  const level     = resp.readFloatLE(3);           // м        (рег 0..1)
  const flowM3s   = resp.readFloatLE(7);           // м³/с     (рег 2..3)
  const flow      = flowM3s * 3600;                // м³/ч
  const rawVolume = resp.readInt32LE(11);          //           (рег 4..5)
  const accTime   = resp.readUInt32LE(15);         // мин       (рег 6..7)
  const pu        = resp.readInt16LE(21);          //           (рег 9)
  const volume    = rawVolume * Math.pow(10, pu - 3);

  return { volume, flow, level, accTime, rawVolume, pu };
}

module.exports = {
  crc16Modbus,
  buildReadCurrentRequest,
  parseReadCurrentResponse,
};
