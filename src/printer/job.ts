/**
 * Pure print-job planner: turns a label image + parameters into the exact frame sequence the
 * MakeID-Life app would send. Used by both the dry-run console and the live client.
 * No DOM access.
 */
import { buildPrintBandFrame, buildStatusFrame, CLEARANCE, CUT_TYPE, STATUS_SUB, type PrinterAttributes } from './frames.ts';
import { rasterize, type MonoImage, type RasterResult } from './raster.ts';

export interface PrintJobOptions {
  copies: number;
  /** 1..31, app presets 10/15/20 */
  darkness: number;
  /** CLEARANCE.TRANSLUCENT for die-cut labels, CLEARANCE.DDF for continuous tape (app default) */
  clearance: number;
  /** CUT_TYPE.MULTIPLE is what the app's free editor sends */
  cutType: number;
  /**
   * Value for 0x1B bytes 11-12: the label LENGTH along the feed in dots. CONFIRMED in the
   * bytecode (smali: printDirect 1/3 -> labelWidth * verticalScale) and on hardware: the E1
   * auto-cuts after exactly this many rows. Default: the rasterized feed length.
   */
  labelLengthDotsOverride?: number;
  flip180?: boolean;
}

export const DEFAULT_JOB_OPTIONS: PrintJobOptions = {
  copies: 1,
  darkness: 15,
  clearance: CLEARANCE.DDF,
  cutType: CUT_TYPE.MULTIPLE,
};

export type PlannedFrameKind = 'restore' | 'handshake' | 'band';

export interface PlannedFrame {
  kind: PlannedFrameKind;
  /** 1-based copy index for handshake/band frames */
  copy?: number;
  /** 0-based band index */
  band?: number;
  bytes: Uint8Array;
  note: string;
}

export interface PrintPlan {
  raster: RasterResult;
  frames: PlannedFrame[];
  totalBytes: number;
}

/**
 * Plans the frames for one label. Sequence CONFIRMED from OperateNewProtocolPrinterRunnable.run():
 *   1. `0x10 restore` once before the first copy (loop until the answer is not "resend")
 *   2. per copy: `0x10 search` handshake, then one 0x1B frame per band (remaining counts down to 0)
 * There is no end-of-job frame.
 */
export function planPrintJob(label: MonoImage, attrs: PrinterAttributes, options: Partial<PrintJobOptions> = {}): PrintPlan {
  const opts: PrintJobOptions = { ...DEFAULT_JOB_OPTIONS, ...options };
  const copies = Math.max(1, Math.trunc(opts.copies));
  const raster = rasterize(label, {
    headDots: attrs.headWidthBytes * 8,
    maxRows: attrs.maxPrintRows,
    position: attrs.printPosition,
    exchangeHL: attrs.exchangeHL,
    rotate90: true,
    flip180: opts.flip180 ?? false,
  });
  const labelLengthDots = opts.labelLengthDotsOverride ?? raster.lengthDots;
  const frames: PlannedFrame[] = [];
  frames.push({ kind: 'restore', bytes: buildStatusFrame(STATUS_SUB.RESTORE), note: '0x10 resume (sent once before the first label)' });
  for (let copy = 1; copy <= copies; copy++) {
    frames.push({ kind: 'handshake', copy, bytes: buildStatusFrame(STATUS_SUB.SEARCH), note: `0x10 handshake before copy ${copy}` });
    raster.bands.forEach((band, i) => {
      frames.push({
        kind: 'band',
        copy,
        band: i,
        bytes: buildPrintBandFrame({
          darkness: opts.darkness,
          clearance: opts.clearance,
          cutType: opts.cutType,
          saveType: 0,
          totalCopies: copies,
          copyIndex: copy,
          labelLengthDots,
          bandRows: band.rows,
          bandsRemaining: raster.bands.length - i - 1,
          compressed: band.compressed,
        }),
        note: `band ${i + 1}/${raster.bands.length} rows ${band.top}..${band.top + band.rows - 1}, ${band.raw.length} B raw -> ${band.compressed.length} B lzo`,
      });
    });
  }
  const totalBytes = frames.reduce((n, f) => n + f.bytes.length, 0);
  return { raster, frames, totalBytes };
}
