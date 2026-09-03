/**
 * Bitmap -> printer raster conversion for the wewin new protocol.
 * Mirrors CreateNewProtocolArray.getDotArrayFromPixelsForNewProtocol (2.2.0) for the
 * background-image case with printDirect = 1 (the value the MakeID-Life app always uses).
 * No DOM access: works on an ImageData-shaped object {width, height, data(RGBA)}.
 */
import { lzo1xCompress } from './lzo1x.ts';
import type { PrintPosition } from './frames.ts';

/** Structural stand-in for ImageData so the module has no DOM dependency. */
export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major */
  data: Uint8ClampedArray | Uint8Array;
}

/** 1 bit per pixel image: `bits[y * width + x]` is 1 for black. */
export interface MonoImage {
  width: number;
  height: number;
  bits: Uint8Array;
}

/** Threshold used by the SDK (wewinPrinterManager.dotConvertValue). CONFIRMED */
export const DOT_CONVERT_VALUE = 128;

/**
 * SDK pixel rule (CreateNewProtocolArray:1290-1300): every RGB channel is thresholded at
 * DOT_CONVERT_VALUE; the pixel is black unless the thresholded ARGB is 0x00000000 or 0xFFFFFFFF.
 * In practice: black when any channel < 128, except a fully transparent black pixel.
 */
export function isBlackPixel(r: number, g: number, b: number, a: number, threshold = DOT_CONVERT_VALUE): boolean {
  const tr = r >= threshold ? 0xff : 0;
  const tg = g >= threshold ? 0xff : 0;
  const tb = b >= threshold ? 0xff : 0;
  const allWhite = tr === 0xff && tg === 0xff && tb === 0xff && a === 0xff;
  const transparentBlack = a === 0 && tr === 0 && tg === 0 && tb === 0;
  if (allWhite || transparentBlack) return false;
  // The SDK canvas is drawn on white (drawColor(-1)) before thresholding when there is no
  // transparency, so a transparent-but-non-black pixel would have become white. Treat any pixel
  // with alpha 0 as white to match what the printer would have seen.
  if (a === 0) return false;
  return true;
}

export function rgbaToMono(img: RgbaImage, threshold = DOT_CONVERT_VALUE): MonoImage {
  const bits = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, p = 0; i < bits.length; i++, p += 4) {
    bits[i] = isBlackPixel(d[p], d[p + 1], d[p + 2], d[p + 3], threshold) ? 1 : 0;
  }
  return { width: img.width, height: img.height, bits };
}

/**
 * Rotates a mono image 90 degrees clockwise (Android Matrix.setRotate(90) on a y-down canvas):
 * pixel (x, y) -> (H - 1 - y, x). Result is H wide and W tall.
 */
export function rotate90cw(img: MonoImage): MonoImage {
  const { width: w, height: h, bits } = img;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = h - 1 - y;
      const ny = x;
      out[ny * h + nx] = bits[y * w + x];
    }
  }
  return { width: h, height: w, bits: out };
}

export function rotate180(img: MonoImage): MonoImage {
  const { width: w, height: h, bits } = img;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[out.length - 1 - i] = bits[i];
  return { width: w, height: h, bits: out };
}

/**
 * Places `img` on a canvas exactly `headDots` wide (CreateNewProtocolArray:1215-1250):
 * left / center / right, cropped symmetrically when wider than the head.
 */
export function placeOnHead(img: MonoImage, headDots: number, position: PrintPosition): MonoImage {
  const out = new Uint8Array(headDots * img.height);
  let dx: number;
  if (position === 'right') {
    dx = Math.max(headDots - img.width, 0);
  } else if (position === 'left') {
    dx = 0;
  } else {
    dx = Math.trunc((headDots - img.width) / 2);
  }
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= headDots) continue;
      out[y * headDots + tx] = img.bits[y * img.width + x];
    }
  }
  return { width: headDots, height: img.height, bits: out };
}

/**
 * Packs rows to bytes: 1 bpp, MSB first, ceil(width/8) bytes per row, zero padded.
 * CONFIRMED (CreateNewProtocolArray:1300-1320).
 */
export function packRows(img: MonoImage): { bytesPerRow: number; data: Uint8Array } {
  const bytesPerRow = Math.ceil(img.width / 8);
  const data = new Uint8Array(bytesPerRow * img.height);
  for (let y = 0; y < img.height; y++) {
    const rowBase = y * bytesPerRow;
    const srcBase = y * img.width;
    for (let x = 0; x < img.width; x++) {
      if (img.bits[srcBase + x]) {
        data[rowBase + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { bytesPerRow, data };
}

/** Swaps every byte pair in place (SDK `isExchangeHL`). CONFIRMED (CreateNewProtocolArray:1316-1321). */
export function swapBytePairs(data: Uint8Array): Uint8Array {
  for (let i = 0; i + 1 < data.length; i += 2) {
    const t = data[i];
    data[i] = data[i + 1];
    data[i + 1] = t;
  }
  return data;
}

export interface RasterBand {
  /** first row of this band within the feed direction */
  top: number;
  rows: number;
  bytesPerRow: number;
  /** uncompressed packed rows (after optional byte-pair swap) */
  raw: Uint8Array;
  /** LZO1X-1 compressed `raw` */
  compressed: Uint8Array;
}

export interface RasterOptions {
  /** dots across the print head (headWidthBytes * 8) */
  headDots: number;
  /** rows per band (status bytes 41-42, SDK default 56) */
  maxRows: number;
  position: PrintPosition;
  exchangeHL: boolean;
  /** rotate the label 90 degrees clockwise before placing it on the head (printDirect = 1). Default true. */
  rotate90?: boolean;
  /** additional 180 degree flip of the wire image (orientation on the tape). Default false. */
  flip180?: boolean;
}

export interface RasterResult {
  /** the image as it travels across the head: width = headDots, height = feed length */
  wireImage: MonoImage;
  bytesPerRow: number;
  bands: RasterBand[];
  /** label extent across the tape in dots, before placement on the head */
  labelHeightDots: number;
  /** feed length in dots (this is what goes into 0x1B bytes 11-12) */
  lengthDots: number;
}

/**
 * Full pipeline: label image (as designed: width = length along the tape, height = tape extent)
 * -> rotate 90 cw (printDirect 1) -> place on head -> pack -> swap -> bands -> LZO.
 * CONFIRMED sequence (CreateNewProtocolArray + wewinPrinterManager.CreateDotArray).
 */
export function rasterize(label: MonoImage, opts: RasterOptions): RasterResult {
  const rotate90 = opts.rotate90 ?? true;
  // The SDK rounds the head-axis extent up to a multiple of 8 before rotating.
  let src = label;
  if (rotate90) {
    const padded = src.height % 8 === 0 ? src.height : src.height + (8 - (src.height % 8));
    if (padded !== src.height) src = padHeight(src, padded);
    src = rotate90cw(src);
  } else {
    const padded = src.width % 8 === 0 ? src.width : src.width + (8 - (src.width % 8));
    if (padded !== src.width) src = padWidth(src, padded);
  }
  if (opts.flip180) src = rotate180(src);
  const labelHeightDots = rotate90 ? label.height : label.width;
  const wire = placeOnHead(src, opts.headDots, opts.position);
  const bands: RasterBand[] = [];
  const maxRows = Math.max(1, opts.maxRows | 0);
  for (let top = 0; top < wire.height; top += maxRows) {
    const rows = Math.min(maxRows, wire.height - top);
    const slice: MonoImage = {
      width: wire.width,
      height: rows,
      bits: wire.bits.subarray(top * wire.width, (top + rows) * wire.width),
    };
    const packed = packRows(slice);
    const raw = opts.exchangeHL ? swapBytePairs(packed.data) : packed.data;
    bands.push({ top, rows, bytesPerRow: packed.bytesPerRow, raw, compressed: lzo1xCompress(raw) });
  }
  if (bands.length > 256) {
    throw new Error(`label too long: ${bands.length} bands (max 256 with ${maxRows} rows each)`);
  }
  return { wireImage: wire, bytesPerRow: Math.ceil(wire.width / 8), bands, labelHeightDots, lengthDots: wire.height };
}

function padHeight(img: MonoImage, newHeight: number): MonoImage {
  const out = new Uint8Array(img.width * newHeight);
  // centre vertically like the SDK does when it scales into the padded canvas? The SDK creates a
  // scaled bitmap of the padded size (stretching by < 8 px). We pad with white instead, centred.
  const offset = Math.trunc((newHeight - img.height) / 2);
  out.set(img.bits, offset * img.width);
  return { width: img.width, height: newHeight, bits: out };
}

function padWidth(img: MonoImage, newWidth: number): MonoImage {
  const out = new Uint8Array(newWidth * img.height);
  const offset = Math.trunc((newWidth - img.width) / 2);
  for (let y = 0; y < img.height; y++) {
    out.set(img.bits.subarray(y * img.width, (y + 1) * img.width), y * newWidth + offset);
  }
  return { width: newWidth, height: img.height, bits: out };
}
