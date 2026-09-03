import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlackPixel, packRows, placeOnHead, rasterize, rgbaToMono, rotate90cw, swapBytePairs, type MonoImage } from '../raster.ts';
import { lzo1xDecompress } from '../lzo1x.ts';
import { planPrintJob } from '../job.ts';
import { SDK_DEFAULT_ATTRIBUTES, CLEARANCE } from '../frames.ts';

function mono(rows: string[]): MonoImage {
  const height = rows.length;
  const width = rows[0].length;
  const bits = new Uint8Array(width * height);
  rows.forEach((r, y) => {
    for (let x = 0; x < width; x++) bits[y * width + x] = r[x] === '#' ? 1 : 0;
  });
  return { width, height, bits };
}

function show(img: MonoImage): string[] {
  const out: string[] = [];
  for (let y = 0; y < img.height; y++) {
    let s = '';
    for (let x = 0; x < img.width; x++) s += img.bits[y * img.width + x] ? '#' : '.';
    out.push(s);
  }
  return out;
}

test('isBlackPixel follows the SDK threshold rule', () => {
  assert.equal(isBlackPixel(0, 0, 0, 255), true);
  assert.equal(isBlackPixel(255, 255, 255, 255), false);
  assert.equal(isBlackPixel(127, 255, 255, 255), true, 'any channel below 128 is black');
  assert.equal(isBlackPixel(128, 128, 128, 255), false, '128 counts as white');
  assert.equal(isBlackPixel(0, 0, 0, 0), false, 'fully transparent black is not printed');
  assert.equal(isBlackPixel(255, 0, 0, 255), true);
});

test('rgbaToMono thresholds RGBA data', () => {
  const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 200, 20, 20, 255, 0, 0, 0, 0]);
  const m = rgbaToMono({ width: 4, height: 1, data });
  assert.deepEqual(Array.from(m.bits), [1, 0, 1, 0]);
});

test('packRows: MSB first, ceil(width/8) bytes per row, zero padded', () => {
  const img = mono(['#.......', '.......#', '##......']);
  const { bytesPerRow, data } = packRows(img);
  assert.equal(bytesPerRow, 1);
  assert.deepEqual(Array.from(data), [0x80, 0x01, 0xc0]);
  const wide = mono(['#........#']); // 10 px -> 2 bytes
  const p2 = packRows(wide);
  assert.equal(p2.bytesPerRow, 2);
  assert.deepEqual(Array.from(p2.data), [0x80, 0x40]);
});

test('swapBytePairs swaps adjacent bytes, odd tail untouched', () => {
  assert.deepEqual(Array.from(swapBytePairs(new Uint8Array([1, 2, 3, 4, 5]))), [2, 1, 4, 3, 5]);
});

test('rotate90cw maps (x, y) -> (H-1-y, x)', () => {
  const img = mono(['#..', '...']); // 3 wide, 2 tall, black at (0,0)
  const r = rotate90cw(img);
  assert.equal(r.width, 2);
  assert.equal(r.height, 3);
  assert.deepEqual(show(r), ['.#', '..', '..']);
  const img2 = mono(['##.', '..#']);
  assert.deepEqual(show(rotate90cw(img2)), ['.#', '.#', '#.']);
});

test('placeOnHead centres, left/right aligns, and crops symmetrically', () => {
  const img = mono(['##']);
  assert.deepEqual(show(placeOnHead(img, 6, 'center')), ['..##..']);
  assert.deepEqual(show(placeOnHead(img, 6, 'left')), ['##....']);
  assert.deepEqual(show(placeOnHead(img, 6, 'right')), ['....##']);
  const wide = mono(['#.####.#']);
  assert.deepEqual(show(placeOnHead(wide, 4, 'center')), ['####']);
});

test('rasterize: rotation, head placement, banding, swap and LZO round trip', () => {
  // label 4 dots long (x), 3 dots across the tape (y); black pixel at top-left
  const label = mono(['#...', '....', '....']);
  const res = rasterize(label, { headDots: 16, maxRows: 3, position: 'center', exchangeHL: false, rotate90: true });
  // height padded to 8 (centred: 2 rows above, 3 rows below) then rotated -> 8 wide x 4 tall
  assert.equal(res.wireImage.width, 16);
  assert.equal(res.lengthDots, 4);
  assert.equal(res.labelHeightDots, 3);
  assert.equal(res.bytesPerRow, 2);
  assert.equal(res.bands.length, 2, 'ceil(4/3) bands');
  assert.equal(res.bands[0].rows, 3);
  assert.equal(res.bands[1].rows, 1);
  // black pixel: label (0,0) -> padded (0,2) -> rotated (8-1-2, 0) = (5,0) -> centred +4 -> (9,0)
  const row0 = res.wireImage.bits.subarray(0, 16);
  assert.equal(Array.from(row0).indexOf(1), 9);
  assert.deepEqual(Array.from(res.bands[0].raw.subarray(0, 2)), [0x00, 0x40], 'x=9 -> byte 1 bit 6');
  for (const b of res.bands) {
    const d = lzo1xDecompress(b.compressed, b.raw.length);
    assert.deepEqual(Array.from(d), Array.from(b.raw));
  }
  const swapped = rasterize(label, { headDots: 16, maxRows: 3, position: 'center', exchangeHL: true, rotate90: true });
  assert.deepEqual(Array.from(swapped.bands[0].raw.subarray(0, 2)), [0x40, 0x00]);
});

test('rasterize enforces the 256-band limit', () => {
  const label: MonoImage = { width: 300, height: 8, bits: new Uint8Array(300 * 8) };
  assert.throws(() => rasterize(label, { headDots: 96, maxRows: 1, position: 'center', exchangeHL: false }));
});

test('planPrintJob emits restore, then per copy a handshake and all bands with a countdown', () => {
  const label: MonoImage = { width: 120, height: 96, bits: new Uint8Array(120 * 96) };
  const attrs = { ...SDK_DEFAULT_ATTRIBUTES, headWidthBytes: 12, maxPrintRows: 56 };
  const plan = planPrintJob(label, attrs, { copies: 2, darkness: 20, clearance: CLEARANCE.TRANSLUCENT });
  const kinds = plan.frames.map((f) => f.kind);
  const bands = Math.ceil(120 / 56); // 3
  assert.equal(plan.raster.bands.length, bands);
  assert.deepEqual(kinds, ['restore', 'handshake', 'band', 'band', 'band', 'handshake', 'band', 'band', 'band']);
  const firstBand = plan.frames[2].bytes;
  assert.equal(firstBand[3], 0x1b);
  assert.equal(firstBand[4], 20 | 0x00);
  assert.equal(firstBand[6], 2, 'total copies');
  assert.equal(firstBand[8], 1, 'copy index');
  assert.equal(firstBand[11] | (firstBand[12] << 8), 120, 'label length along the feed (dots)');
  assert.equal(firstBand[13], 56);
  assert.equal(firstBand[15], 2, 'remaining after first band');
  const lastBand = plan.frames[4].bytes;
  assert.equal(lastBand[13], 120 - 112, 'last band rows');
  assert.equal(lastBand[15], 0);
  const secondCopyBand = plan.frames[6].bytes;
  assert.equal(secondCopyBand[8], 2, 'second copy index');
});
