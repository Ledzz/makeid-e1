import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributesFromStatus,
  buildFirmwareQueryFrame,
  buildPrintBandFrame,
  buildStatusFrame,
  classifyResponse,
  CLEARANCE,
  CUT_TYPE,
  isOccupiedFrame,
  isPowerOffFrame,
  parseFirmwareResponse,
  parseStatusFrame,
  STATUS_SUB,
} from '../frames.ts';
import { checksumOf } from '../checksum.ts';
import { fromHex, toHex } from '../hex.ts';

test('status frames match the SDK byte arrays', () => {
  assert.equal(toHex(buildStatusFrame(STATUS_SUB.SEARCH)), '66 06 00 10 00 84');
  assert.equal(toHex(buildStatusFrame(STATUS_SUB.PAUSE)), '66 06 00 10 01 83');
  assert.equal(toHex(buildStatusFrame(STATUS_SUB.RESTORE)), '66 06 00 10 02 82');
  assert.equal(toHex(buildStatusFrame(STATUS_SUB.CANCEL)), '66 06 00 10 03 81');
  assert.equal(toHex(buildFirmwareQueryFrame()), '66 05 00 50 45');
});

test('0x1B band frame layout (operate1BCommand)', () => {
  const lzo = new Uint8Array([0x12, 0x34, 0x56, 0x11, 0x00, 0x00]);
  const f = buildPrintBandFrame({
    darkness: 15,
    clearance: CLEARANCE.DDF,
    cutType: CUT_TYPE.MULTIPLE,
    totalCopies: 2,
    copyIndex: 1,
    labelLengthDots: 96,
    bandRows: 56,
    bandsRemaining: 3,
    compressed: lzo,
  });
  assert.equal(f.length, 18 + lzo.length);
  assert.equal(f[0], 0x66);
  assert.equal(f[1] | (f[2] << 8), f.length);
  assert.equal(f[3], 0x1b);
  assert.equal(f[4], 15 | 0x20, 'darkness | clearance');
  assert.equal(f[5], 3, 'cut type, save type 0');
  assert.equal(f[6] | (f[7] << 8), 2, 'total copies');
  assert.equal(f[8] | (f[9] << 8), 1, 'copy index');
  assert.equal(f[10], 1);
  assert.equal(f[11] | (f[12] << 8), 96, 'label length dots');
  assert.equal(f[13] | (f[14] << 8), 56, 'band rows');
  assert.equal(f[15], 3, 'bands remaining');
  assert.equal(f[16], 0);
  assert.deepEqual(Array.from(f.subarray(17, 17 + lzo.length)), Array.from(lzo));
  assert.equal(f[f.length - 1], checksumOf(f.subarray(0, f.length - 1)));
});

test('0x1B frame: darkness 0 is sent as 31, cut type -1 as 7, 16-bit fields little-endian', () => {
  const big = new Uint8Array(300).fill(0xaa);
  const f = buildPrintBandFrame({
    darkness: 0,
    clearance: CLEARANCE.TRANSLUCENT,
    cutType: -1,
    totalCopies: 300,
    copyIndex: 257,
    labelLengthDots: 0x1234,
    bandRows: 0x0102,
    bandsRemaining: 0,
    compressed: big,
  });
  assert.equal(f[4], 0x1f);
  assert.equal(f[5], 0x07);
  assert.equal(f[6], 300 & 0xff);
  assert.equal(f[7], 300 >> 8);
  assert.equal(f[8], 0x01);
  assert.equal(f[9], 0x01);
  assert.equal(f[11], 0x34);
  assert.equal(f[12], 0x12);
  assert.equal(f[13], 0x02);
  assert.equal(f[14], 0x01);
  assert.equal(f[1] | (f[2] << 8), 318);
});

function statusFixture(overrides: Partial<Record<number, number>> = {}, length = 44): Uint8Array {
  const raw = new Uint8Array(length);
  raw[0] = 0x66;
  raw[1] = length & 0xff;
  raw[2] = length >> 8;
  raw[3] = 0x10;
  raw[4] = 0x00; // OK
  raw[5] = 0x80 | 75; // charging, 75 %
  raw[6] = 0x10; // 203 dpi, has Bluetooth
  raw[7] = 15; // darkness
  raw[8] = 96;
  raw[9] = 0;
  raw.set([0x45, 0x31, 0x20, 0x20, 0x20], 10); // "E1   "
  raw[15] = 0x01; // vertical 203
  raw[35] = 0x00;
  raw[36] = 1;
  raw[37] = 3;
  raw[38] = 0x01 | 0x04; // center, swap
  raw[39] = 12;
  raw[40] = 0;
  raw[41] = 56;
  raw[42] = 0;
  for (const [k, v] of Object.entries(overrides)) raw[Number(k)] = v as number;
  raw[length - 1] = checksumOf(raw.subarray(0, length - 1));
  return raw;
}

test('parseStatusFrame decodes the documented fields', () => {
  const st = parseStatusFrame(statusFixture());
  assert.equal(st.commandEcho, 0x10);
  assert.equal(st.checksumOk, true);
  assert.equal(st.statusCode, 0);
  assert.equal(st.wait, false);
  assert.equal(st.resend, false);
  assert.equal(st.batteryPercent, 75);
  assert.equal(st.charging, true);
  assert.equal(st.horizontalDpi, 203);
  assert.equal(st.verticalDpi, 203);
  assert.equal(st.hasBluetooth, true);
  assert.equal(st.hasRfid, false);
  assert.equal(st.darkness, 15);
  assert.equal(st.labelHeight, 96);
  assert.equal(st.printerType, 'E1');
  assert.equal(st.protocolVersion, 1.3);
  assert.equal(st.printPosition, 'center');
  assert.equal(st.exchangeHL, true);
  assert.equal(st.headWidthBytes, 12);
  assert.equal(st.maxPrintRows, 56);
  assert.equal(st.requestType, 'none');
  assert.equal(st.printing, false);
});

test('battery 127 means 100 %, wait/resend bits, request bits, printing bit', () => {
  const st = parseStatusFrame(statusFixture({ 5: 127, 4: 0xc0, 35: 0x80 | (1 << 5) }));
  assert.equal(st.batteryPercent, 100);
  assert.equal(st.charging, false);
  assert.equal(st.wait, true);
  assert.equal(st.resend, true);
  assert.equal(st.requestType, 'pause');
  assert.equal(st.printing, true);
});

test('classifyResponse follows parsingResponseByteArray', () => {
  assert.equal(classifyResponse(null), 'resnull');
  assert.equal(classifyResponse(new Uint8Array(0)), 'resnull');
  assert.equal(classifyResponse(fromHex('66 06 00 11 00 83')), 'resnull');
  assert.equal(classifyResponse(fromHex('66 06 00 10 00 84')), 'resend', 'short frames are resend');
  assert.equal(classifyResponse(statusFixture()), 'success');
  assert.equal(classifyResponse(statusFixture({ 4: 0x80 })), 'wait');
  assert.equal(classifyResponse(statusFixture({ 4: 0x40 })), 'resend');
  assert.equal(classifyResponse(statusFixture({ 4: 6 })), 'error');
  assert.equal(classifyResponse(statusFixture({ 4: 16 })), 'exit');
  assert.equal(classifyResponse(statusFixture({ 4: 17 })), 'reprint');
  assert.equal(classifyResponse(statusFixture({ 4: 23 })), 'success');
  assert.equal(classifyResponse(statusFixture({ 35: 1 << 5 })), 'pause');
  assert.equal(classifyResponse(statusFixture({ 35: 3 << 5 })), 'exit');
});

test('attributesFromStatus takes >=1.3 fields only when reported', () => {
  const a = attributesFromStatus(parseStatusFrame(statusFixture()));
  assert.ok(a);
  assert.equal(a.fromPrinter, true);
  assert.equal(a.headWidthBytes, 12);
  assert.equal(a.maxPrintRows, 56);
  assert.equal(a.exchangeHL, true);
  assert.equal(a.printPosition, 'center');
  const old = attributesFromStatus(parseStatusFrame(statusFixture({}, 40)));
  assert.ok(old);
  assert.equal(old.protocolVersion, null);
  assert.equal(old.headWidthBytes, 72, 'SDK default when not reported');
  const legacy = attributesFromStatus(parseStatusFrame(statusFixture({ 36: 1, 37: 0 })));
  assert.ok(legacy);
  assert.equal(legacy.protocolVersion, 1.0);
  assert.equal(legacy.headWidthBytes, 72);
  assert.equal(attributesFromStatus(parseStatusFrame(statusFixture({ 3: 0x11 }))), null);
});

test('special frames', () => {
  assert.equal(isOccupiedFrame(fromHex('66 06 00 11 00 83')), true);
  assert.equal(isOccupiedFrame(fromHex('66 06 00 10 00 84')), false);
  assert.equal(isPowerOffFrame(fromHex('66 09 00 2A 2A 2A 2A 2A 00')), true);
  assert.equal(isPowerOffFrame(fromHex('66 06 00 10 00 84')), false);
});

test('parseFirmwareResponse splits NUL-terminated strings from byte 4', () => {
  const body = new TextEncoder().encode('HW1.0\0FW2.3.4\0');
  const frame = new Uint8Array(4 + body.length + 1);
  frame.set([0x66, frame.length, 0, 0x50], 0);
  frame.set(body, 4);
  frame[frame.length - 1] = checksumOf(frame.subarray(0, frame.length - 1));
  assert.deepEqual(parseFirmwareResponse(frame), ['HW1.0', 'FW2.3.4']);
});
