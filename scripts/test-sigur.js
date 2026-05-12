'use strict';
// Тест адаптера протокола Эхо Сигнур по примеру из signur.txt.
// Запуск: node scripts/test-sigur.js

const { buildReadCurrentRequest, parseReadCurrentResponse, crc16Modbus } = require('../src/sigur');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

function check(label, actual, expected, eps = 0) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= eps
    : actual === expected;
  console.log(`${ok ? 'OK ' : 'FAIL'}  ${label}: получено=${actual}, ожидалось=${expected}`);
  return ok;
}

let pass = 0, total = 0;

// 1) Запрос команды 0x66 для адреса 0x01 → ожидаемые байты "01 66 80 0A".
total++;
const req = buildReadCurrentRequest(0x01);
const reqHex = req.toString('hex').toUpperCase().match(/.{2}/g).join(' ');
if (check('запрос 0x66 (адрес 1)', reqHex, '01 66 80 0A')) pass++;

// 2) CRC отдельно: CRC16-Modbus([0x01, 0x66]) = 0x0A80.
total++;
if (check('CRC16-Modbus([01 66])', crc16Modbus(Buffer.from([0x01, 0x66])).toString(16), 'a80')) pass++;

// 3) Разбор реального ответа из signur.txt (прибор ЭХО-Р-03-1, адрес 1):
//    01 66 12 9A 99 99 3E 54 DF 4B 3D 6D 00 04 00 7A 7C 00 00 02 00 81 18
//    flow ≈ 179.2 м³/ч, volume = 26225.3 м³, time = 31866 мин, errorCode = 0.
total++;
const resp = hex('01 66 12 9A 99 99 3E 54 DF 4B 3D 6D 00 04 00 7A 7C 00 00 02 00 81 18');
try {
  const r = parseReadCurrentResponse(resp, 0x01);
  console.log(`Разбор: volume=${r.volume.toFixed(3)} м³, flow=${r.flow.toFixed(3)} м³/ч, ` +
              `level=${r.level.toFixed(4)} м, time=${r.time} мин, err=${r.errorCode}, raw=${r.rawVolume}, Pu=${r.pu}`);
  let ok = true;
  ok &= check('  volume',     +r.volume.toFixed(1),  26225.3, 0.01);
  ok &= check('  flow м³/ч',  +r.flow.toFixed(1),    179.2,   0.05);
  ok &= check('  errorCode',  r.errorCode,           0);
  ok &= check('  time, мин',  r.time,                31866);
  ok &= check('  rawVolume',  r.rawVolume,           262253);
  ok &= check('  Pu',         r.pu,                  2);
  if (ok) pass++;
} catch (e) {
  console.log(`FAIL  разбор ответа: ${e.message}`);
}

console.log(`\nИтог: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
