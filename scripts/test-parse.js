'use strict';
// Тест декодирования реальных кадров обмена со счётчиком (см. device.log).
// Запуск: node scripts/test-parse.js

const {
  parseReadChannelsResponse,
  parseReadParamResponse,
} = require('../src/pulsar');

// Хелпер: строка вида "14 41 59 12 ..." → Buffer.
const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

const DEVICE = '14415912';

// 1) Объём — F=0x01, ID=0x0001, ожидаемое значение 44889.09375.
const respVolume = hex('14 41 59 12 01 0E 18 59 2F 47 01 00 8A 49');
const expectedVolume = 44889.09375;

// 2) Расход — F=0x0A, ID=0x0002, ожидаемое значение ≈ 21.3243046.
const respFlow = hex('14 41 59 12 0A 12 2D 98 AA 41 00 00 00 00 02 00 96 11');
const expectedFlow = 21.3243046;

function fmt(n) { return Number(n).toFixed(7); }
function check(label, actual, expected, eps) {
  const ok = Math.abs(actual - expected) < eps;
  console.log(`${ok ? 'OK ' : 'FAIL'}  ${label}: получено=${fmt(actual)}, ожидалось=${fmt(expected)}`);
  return ok;
}

console.log('=== Тест декодирования протокола «Пульсар-М» ===');
console.log(`Прибор №${DEVICE}\n`);

let pass = 0, total = 0;

// Объём (автоопределение типа по длине пакета).
total++;
try {
  const v = parseReadChannelsResponse(respVolume, DEVICE, 0x0001);
  console.log(`Объём: тип=${v.valueType}, каналов=${v.channels.length}`);
  if (check('  значение объёма', v.channels[0], expectedVolume, 1e-4)) pass++;
} catch (e) {
  console.log(`FAIL  объём: исключение ${e.message}`);
}

// Расход.
total++;
try {
  const f = parseReadParamResponse(respFlow, DEVICE, 0x0002);
  console.log(`\nРасход:`);
  if (check('  значение расхода', f.value, expectedFlow, 1e-4)) pass++;
} catch (e) {
  console.log(`FAIL  расход: исключение ${e.message}`);
}

console.log(`\nИтог: ${pass}/${total}`);

// Экспорт значений — пригодится для инъекции в UI.
if (require.main === module) {
  console.log('\nДля проверки UI: открой DevTools и выполни в консоли:');
  console.log(`  window.__injectTestResult({ idx:0, value:${expectedVolume}, flow:${expectedFlow} })`);
}

module.exports = { expectedVolume, expectedFlow };
