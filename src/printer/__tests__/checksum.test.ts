import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksumOf, verifyChecksum, wewinChecksum } from '../checksum.ts';
import { fromHex } from '../hex.ts';

// Frames literally present in the decompiled SDK (byte values as Java signed ints converted):
//   operate10Check          -> 66 06 00 10 00 | 0x84 (-124)
//   operateA0ShakeHand      -> 66 05 A0 00    | 0xF5 (-11)
//   operateCheck (A1)       -> 66 05 A1 00    | 0xF4 (-12)
//   operatePrinterName (B5) -> 66 05 B5 00    | 0xE0 (-32)
//   occupied response       -> 66 06 00 11 00 | 0x83 (-125)
//   P30 A1 variant          -> 66 05 A0 00 F5 (same as A0)
const vectors: Array<[string, number]> = [
  ['66 06 00 10 00', 0x84],
  ['66 05 A0 00', 0xf5],
  ['66 05 A1 00', 0xf4],
  ['66 05 B5 00', 0xe0],
  ['66 06 00 11 00', 0x83],
  ['66 06 00 10 02', 0x82],
  ['66 06 00 10 03', 0x81],
  ['66 05 00 50', 0x45],
];

test('checksumOf reproduces the SDK constants', () => {
  for (const [hex, expected] of vectors) {
    assert.equal(checksumOf(fromHex(hex)), expected, hex);
  }
});

test('wewinChecksum over a frame with an empty slot matches getCheckNum', () => {
  for (const [hex, expected] of vectors) {
    const withSlot = new Uint8Array([...fromHex(hex), 0]);
    assert.equal(wewinChecksum(withSlot), expected, hex);
  }
});

test('verifyChecksum accepts valid frames and rejects corrupted ones', () => {
  const good = fromHex('66 06 00 10 00 84');
  assert.equal(verifyChecksum(good), true);
  const bad = fromHex('66 06 00 10 01 84');
  assert.equal(verifyChecksum(bad), false);
  assert.equal(verifyChecksum(new Uint8Array([0x66])), false);
});

test('checksum is the two-complement of the byte sum', () => {
  const rnd = new Uint8Array(300);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 73 + 11) & 0xff;
  const ck = checksumOf(rnd);
  let sum = 0;
  for (const b of rnd) sum += b;
  assert.equal((sum + ck) & 0xff, 0);
});
