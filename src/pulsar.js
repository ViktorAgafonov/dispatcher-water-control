'use strict';

// Протокол Пульсар-М: формирование запросов и разбор ответов.

function crc16(buf) {
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

// Кодирование сетевого адреса (десятичный номер прибора) в BCD 4 байта, старшим байтом вперёд.
function encodeAddrBCD(deviceNumber) {
  const s = String(deviceNumber).padStart(8, '0').slice(-8);
  const b = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const hi = s.charCodeAt(i * 2) - 48;
    const lo = s.charCodeAt(i * 2 + 1) - 48;
    b[i] = ((hi & 0x0F) << 4) | (lo & 0x0F);
  }
  return b;
}

function decodeAddrBCD(buf) {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += ((buf[i] >> 4) & 0x0F).toString() + (buf[i] & 0x0F).toString();
  }
  return s.replace(/^0+/, '') || '0';
}

let _idCounter = 0;
function nextId() {
  _idCounter = (_idCounter + 1) & 0xFFFF;
  const b = Buffer.alloc(2);
  b.writeUInt16LE(_idCounter, 0);
  return b;
}

// Формирование запроса чтения текущих показаний (F=0x01) — объём по каналу.
// deviceNumber — сетевой адрес (номер счётчика), channel — номер канала 1..32.
function buildReadChannelsRequest(deviceNumber, channel) {
  const addr = encodeAddrBCD(deviceNumber);
  const F = 0x01;
  const L = 14; // 4+1+1+4+2+2
  const mask = Buffer.alloc(4);
  mask.writeUInt32LE(1 << (channel - 1), 0);
  const id = nextId();
  const pkt = Buffer.concat([addr, Buffer.from([F, L]), mask, id]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16(pkt), 0);
  return { packet: Buffer.concat([pkt, crc]), id };
}

// Формирование запроса чтения текущего параметра (F=0x0A).
// param16 — 16-битный идентификатор параметра (LE):
//   0x0100 — мгновенный расход [м³/ч] (для водосчётчика «Пульсар»).
function buildReadParamRequest(deviceNumber, param16) {
  const addr = encodeAddrBCD(deviceNumber);
  const F = 0x0A;
  const L = 12; // 4+1+1+2+2+2
  const mask = Buffer.alloc(2);
  mask.writeUInt16LE(param16 & 0xFFFF, 0);
  const id = nextId();
  const pkt = Buffer.concat([addr, Buffer.from([F, L]), mask, id]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16(pkt), 0);
  return { packet: Buffer.concat([pkt, crc]), id };
}

// Краткое описание известных кодов ошибок прибора (F=0x00).
const ERROR_CODES = {
  0x01: 'отсутствуют запрошенные данные',
  0x02: 'неподдерживаемая команда',
  0x03: 'ошибка длины пакета',
  0x04: 'ошибка записи',
  0x05: 'занят (выполняется операция)',
  0x06: 'недостаточный уровень доступа',
};

function describeErrorCode(code) {
  const hex = `0x${code.toString(16).padStart(2, '0').toUpperCase()}`;
  const txt = ERROR_CODES[code];
  return txt ? `${hex} (${txt})` : hex;
}

// Разбор ответа на F=0x01 с одним каналом.
// Тип значения определяется автоматически по длине полезной нагрузки:
//   4 байта → float32 (беспроводные «Пульсар 16РМ-М», «Пульсар 24М»);
//   8 байт → float64 (проводные счётчики).
// options.valueType (необязательный) принудительно задаёт тип, иначе — автоопределение.
function parseReadChannelsResponse(buf, expectedDevice, expectedId, options = {}) {
  const head = parseFrameHeader(buf, expectedDevice, expectedId, 0x01);
  const { pkt, L } = head;
  // Полезная нагрузка: L - 6 (addr+F+L) - 2 (id) - 2 (crc).
  const payloadLen = L - 6 - 2 - 2;

  let elemSize;
  if (options.valueType === 'float32') elemSize = 4;
  else if (options.valueType === 'float64') elemSize = 8;
  else if (payloadLen === 4) elemSize = 4;
  else if (payloadLen === 8) elemSize = 8;
  else throw new Error(`Неожиданная длина данных: ${payloadLen} (ожидается 4 или 8 байт на канал)`);

  if (payloadLen <= 0 || payloadLen % elemSize !== 0) {
    throw new Error(`Неожиданная длина данных: ${payloadLen} (ожидается кратно ${elemSize})`);
  }
  const valueType = elemSize === 8 ? 'float64' : 'float32';
  const channels = [];
  for (let i = 0; i < payloadLen; i += elemSize) {
    channels.push(elemSize === 8 ? pkt.readDoubleLE(6 + i) : pkt.readFloatLE(6 + i));
  }
  return { addr: head.addr, channels, id: head.id, totalLen: L, valueType };
}

// Разбор ответа на F=0x0A — текущее значение параметра (одно float32 LE в первых 4 байтах данных).
function parseReadParamResponse(buf, expectedDevice, expectedId) {
  const head = parseFrameHeader(buf, expectedDevice, expectedId, 0x0A);
  const { pkt, L } = head;
  const payloadLen = L - 6 - 2 - 2;
  if (payloadLen < 4) {
    throw new Error(`Неожиданная длина данных параметра: ${payloadLen}`);
  }
  const value = pkt.readFloatLE(6);
  return { addr: head.addr, value, id: head.id, totalLen: L };
}

// Общая часть разбора кадра: проверка длины, CRC, адреса, ID, обработка ошибки прибора.
function parseFrameHeader(buf, expectedDevice, expectedId, expectedF) {
  if (!buf || buf.length < 10) throw new Error('Слишком короткий ответ');
  const L = buf[5];
  if (buf.length < L) throw new Error(`Неполный пакет: ${buf.length}/${L}`);
  const pkt = buf.slice(0, L);
  const crcCalc = crc16(pkt.slice(0, L - 2));
  const crcGot = pkt.readUInt16LE(L - 2);
  if (crcCalc !== crcGot) throw new Error('Ошибка CRC');
  const addr = decodeAddrBCD(pkt.slice(0, 4));
  if (String(expectedDevice) !== addr) {
    throw new Error(`Адрес не совпадает: ожидался ${expectedDevice}, получен ${addr}`);
  }
  const F = pkt[4];
  if (F === 0x00) {
    const code = pkt[6];
    const err = new Error(`Ошибка прибора: код ${describeErrorCode(code)}`);
    err.deviceErrorCode = code;
    throw err;
  }
  if (F !== expectedF) {
    throw new Error(`Неожиданный код функции: 0x${F.toString(16)} (ожидался 0x${expectedF.toString(16)})`);
  }
  const id = pkt.readUInt16LE(L - 4);
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error('ID ответа не совпадает с запросом');
  }
  return { pkt, L, addr, id };
}

module.exports = {
  crc16,
  encodeAddrBCD,
  decodeAddrBCD,
  buildReadChannelsRequest,
  parseReadChannelsResponse,
  buildReadParamRequest,
  parseReadParamResponse,
  describeErrorCode,
  // ID параметров (F=0x0A).
  PARAM_FLOW_RATE: 0x0100,
};
