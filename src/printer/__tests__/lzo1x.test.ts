import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lzo1xCompress, lzo1xCompressBound, lzo1xDecompress } from '../lzo1x.ts';

function roundTrip(data: Uint8Array, label: string): Uint8Array {
  const c = lzo1xCompress(data);
  assert.ok(c.length <= lzo1xCompressBound(data.length), `${label}: within compress bound`);
  assert.deepEqual(Array.from(c.subarray(c.length - 3)), [0x11, 0x00, 0x00], `${label}: ends with EOF marker`);
  const d = lzo1xDecompress(c, data.length);
  assert.deepEqual(Array.from(d), Array.from(data), `${label}: round trip`);
  return c;
}

test('empty and tiny inputs (<= 13 bytes are emitted as one literal run)', () => {
  assert.deepEqual(Array.from(lzo1xCompress(new Uint8Array(0))), [0x11, 0x00, 0x00]);
  const one = lzo1xCompress(new Uint8Array([0x42]));
  assert.deepEqual(Array.from(one), [17 + 1, 0x42, 0x11, 0x00, 0x00]);
  for (let n = 1; n <= 13; n++) {
    const data = new Uint8Array(n).map((_, i) => (i * 37) & 0xff);
    const c = roundTrip(data, `tiny ${n}`);
    assert.equal(c[0], 17 + n);
  }
});

test('all-zero band (typical blank label) compresses well', () => {
  const data = new Uint8Array(12 * 56);
  const c = roundTrip(data, 'zeros');
  assert.ok(c.length < 16, `compressed ${c.length} bytes`);
});

test('all-ones and repeating patterns', () => {
  roundTrip(new Uint8Array(12 * 56).fill(0xff), 'ones');
  const pattern = new Uint8Array(1000).map((_, i) => [0xf0, 0x0f, 0xaa, 0x55][i % 4]);
  roundTrip(pattern, 'pattern4');
  const stripes = new Uint8Array(12 * 200).map((_, i) => (Math.floor(i / 12) % 2 ? 0xff : 0x00));
  roundTrip(stripes, 'stripes');
});

test('incompressible pseudo-random data round-trips', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 16) & 0xff;
  };
  for (const n of [14, 15, 100, 1000, 4096, 10000]) {
    const data = new Uint8Array(n).map(() => rnd());
    roundTrip(data, `random ${n}`);
  }
});

test('long matches exercise M3/M4 encodings and offsets beyond 0x4000', () => {
  // text-like content with far-back repeats
  const block = new Uint8Array(3000).map((_, i) => 65 + ((i * 7 + (i >> 5)) % 26));
  const data = new Uint8Array(block.length * 8);
  for (let i = 0; i < 8; i++) data.set(block, i * block.length);
  roundTrip(data, 'far repeats');
  // very long run (> 255 + 33)
  const run = new Uint8Array(5000).fill(0x5a);
  run[0] = 1;
  run[1] = 2;
  run[2] = 3;
  const c = roundTrip(run, 'long run');
  assert.ok(c.length < 40);
});

test('rendered-label-like raster: mostly white with a few black rows', () => {
  const bytesPerRow = 12;
  const rows = 56;
  const data = new Uint8Array(bytesPerRow * rows);
  for (let y = 20; y < 36; y++) {
    for (let x = 2; x < 10; x++) data[y * bytesPerRow + x] = 0xff;
  }
  roundTrip(data, 'label-like');
});

test('decompressor rejects truncated streams', () => {
  const c = lzo1xCompress(new Uint8Array(500).map((_, i) => i & 0xff));
  assert.throws(() => lzo1xDecompress(c.subarray(0, c.length - 3), 500));
  assert.throws(() => lzo1xDecompress(c, 499));
});
