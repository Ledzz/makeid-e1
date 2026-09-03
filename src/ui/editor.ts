/**
 * Label editor: renders text to a monochrome bitmap in printer dots (203 dpi).
 * This is the only module besides app.ts that touches the canvas API.
 */
import { rgbaToMono, rgbaToMonoDithered, type MonoImage } from '../printer/raster.ts';

/** 203 dpi -> dots per mm. The app uses 7.992126 (StaticArgs.dpiConvertPX for the E1 theme). */
export const DOTS_PER_MM = 203 / 25.4;

export function mmToDots(mm: number): number {
  return Math.round(mm * DOTS_PER_MM);
}

export function dotsToMm(dots: number): number {
  return dots / DOTS_PER_MM;
}

/**
 * Tape widths the app offers for the E1 and the printable height it uses for each
 * (DensityUtils.getRealInHeight, E1 branch). CONFIRMED (app), printable height in mm.
 */
export const TAPES: Array<{ widthMm: number; printableMm: number }> = [
  { widthMm: 9, printableMm: 8 },
  { widthMm: 12, printableMm: 11 },
  { widthMm: 16, printableMm: 12 },
];

export type Align = 'left' | 'center' | 'right';

export interface LabelSpec {
  text: string;
  fontSizeDots: number;
  fontFamily: string;
  bold: boolean;
  align: Align;
  /** rotate the text block 90 degrees inside the label (text runs across the tape) */
  rotateText: boolean;
  tapeWidthMm: number;
  /** null = auto (fit text), otherwise fixed label length in mm */
  lengthMm: number | null;
  /** horizontal margin on each side in mm (auto length only adds it; fixed length centres) */
  marginMm: number;
  invert: boolean;
  /** Floyd-Steinberg dithering for photos/emoji instead of a hard threshold */
  dither: boolean;
}

export const DEFAULT_SPEC: LabelSpec = {
  text: '480 100W',
  fontSizeDots: 48,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  bold: true,
  align: 'center',
  rotateText: false,
  tapeWidthMm: 12,
  lengthMm: null,
  marginMm: 2,
  invert: false,
  dither: false,
};

/** App minimum label length for the E1 (DensityUtils.getFreeLabelMinLength). */
export const MIN_LENGTH_MM = 10;
export const MAX_LENGTH_MM = 4000;

export interface RenderedLabel {
  canvas: HTMLCanvasElement;
  mono: MonoImage;
  widthDots: number;
  heightDots: number;
  lengthMm: number;
  truncated: boolean;
}

function fontString(spec: LabelSpec): string {
  return `${spec.bold ? 'bold ' : ''}${spec.fontSizeDots}px ${spec.fontFamily}`;
}

/** Renders the label as it prints: width = length along the tape, height = printable tape extent. */
export function renderLabel(spec: LabelSpec): RenderedLabel {
  const tape = TAPES.find((t) => t.widthMm === spec.tapeWidthMm) ?? TAPES[1];
  const heightDots = mmToDots(tape.printableMm);
  const lines = spec.text.replace(/\r/g, '').split('\n');
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = fontString(spec);
  const lineHeight = Math.round(spec.fontSizeDots * 1.15);
  const textWidth = Math.max(1, ...lines.map((l) => Math.ceil(measure.measureText(l).width)));
  const textHeight = lineHeight * lines.length;
  // extent of the text block along the tape
  const blockLength = spec.rotateText ? textHeight : textWidth;
  const marginDots = mmToDots(spec.marginMm);
  let widthDots: number;
  if (spec.lengthMm === null) {
    widthDots = Math.max(mmToDots(MIN_LENGTH_MM), blockLength + 2 * marginDots);
  } else {
    widthDots = mmToDots(Math.min(MAX_LENGTH_MM, Math.max(MIN_LENGTH_MM, spec.lengthMm)));
  }
  const canvas = document.createElement('canvas');
  canvas.width = widthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = spec.invert ? '#000' : '#fff';
  ctx.fillRect(0, 0, widthDots, heightDots);
  ctx.fillStyle = spec.invert ? '#fff' : '#000';
  ctx.font = fontString(spec);
  ctx.textBaseline = 'middle';
  // crisp text: no smoothing is not controllable for text, thresholding handles it
  ctx.save();
  if (spec.rotateText) {
    // text runs from top to bottom across the tape: rotate the coordinate system 90 deg cw
    ctx.translate(widthDots / 2, heightDots / 2);
    ctx.rotate(Math.PI / 2);
    // now x axis points down the tape height, y axis points against the tape length
    drawLines(ctx, lines, spec.align, heightDots, textHeight, lineHeight);
  } else {
    ctx.translate(widthDots / 2, heightDots / 2);
    drawLines(ctx, lines, spec.align, widthDots, textHeight, lineHeight);
  }
  ctx.restore();
  const img = ctx.getImageData(0, 0, widthDots, heightDots);
  const rgba = { width: img.width, height: img.height, data: img.data };
  const mono = spec.dither ? rgbaToMonoDithered(rgba) : rgbaToMono(rgba);
  const truncated = blockLength + 2 * marginDots > widthDots || textHeight > heightDots;
  return { canvas, mono, widthDots, heightDots, lengthMm: dotsToMm(widthDots), truncated };
}

/** Draws centred lines; origin is the centre of the available box. */
function drawLines(ctx: CanvasRenderingContext2D, lines: string[], align: Align, boxWidth: number, textHeight: number, lineHeight: number): void {
  const half = boxWidth / 2;
  ctx.textAlign = align;
  const x = align === 'left' ? -half + 2 : align === 'right' ? half - 2 : 0;
  const startY = -textHeight / 2 + lineHeight / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, x, startY + i * lineHeight);
  });
}

/** Draws a MonoImage onto a canvas at 1 dot = 1 px (for the "wire" preview). */
export function monoToCanvas(img: { width: number; height: number; bits: Uint8Array }, canvas: HTMLCanvasElement): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(img.width, img.height);
  for (let i = 0, p = 0; i < img.bits.length; i++, p += 4) {
    const v = img.bits[i] ? 0 : 255;
    data.data[p] = v;
    data.data[p + 1] = v;
    data.data[p + 2] = v;
    data.data[p + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
}
