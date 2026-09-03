/**
 * wewin "new protocol" frame builders and parsers (MakeID E1 path).
 * Every byte value here is traced in docs/PROTOCOL.md; nothing is invented.
 * No DOM access.
 */
import { checksumOf, verifyChecksum } from './checksum.ts';

export const START_BYTE = 0x66;

/** Command bytes (frame[3]). CONFIRMED (wewinPrinterOperateHelper, OperateNewProtocolPrinterRunnable). */
export const CMD = {
  /** status / heartbeat / handshake; sub-command in payload byte 4 */
  STATUS: 0x10,
  /** RFID write (not used for the E1) */
  RFID_WRITE: 0x1a,
  /** one raster band */
  PRINT_BAND: 0x1b,
  /** hardware / firmware version strings */
  FIRMWARE: 0x50,
} as const;

/** Sub-commands of CMD.STATUS. CONFIRMED (OperateNewProtocolPrinterRunnable.operateShakeHand). */
export const STATUS_SUB = {
  SEARCH: 0x00,
  PAUSE: 0x01,
  RESTORE: 0x02,
  CANCEL: 0x03,
} as const;

/** Label clearance / tape type bits (frame 0x1B byte 4, bits 5-7). CONFIRMED (operate1BCommand). */
export const CLEARANCE = {
  /** SDK "translucent": what the app sends for die-cut / gap labels (labelType == 2) */
  TRANSLUCENT: 0x00,
  /** SDK "ddf": what the app sends for continuous tape (default) */
  DDF: 0x20,
  BLACKMARK: 0x40,
  NONE: 0xe0,
} as const;

/** Values the app uses for labelCutType (frame 0x1B byte 5 bits 0-2). CONFIRMED (PrinterManagerService). */
export const CUT_TYPE = {
  /** app printType == 1 (single) */
  SINGLE: 2,
  /** app printType == 2 (multiple / free editor); this is what the free editor always sends */
  MULTIPLE: 3,
  /** SDK value when nothing was configured */
  UNSET: 7,
} as const;

/** Builds `66 lenLo lenHi cmd payload... ck`. Length counts the whole frame. */
export function buildFrame(cmd: number, payload: ArrayLike<number> = []): Uint8Array {
  const total = 4 + payload.length + 1;
  if (total > 0xffff) throw new Error(`frame too long: ${total}`);
  const frame = new Uint8Array(total);
  frame[0] = START_BYTE;
  frame[1] = total & 0xff;
  frame[2] = (total >> 8) & 0xff;
  frame[3] = cmd & 0xff;
  for (let i = 0; i < payload.length; i++) frame[4 + i] = payload[i] & 0xff;
  frame[total - 1] = checksumOf(frame.subarray(0, total - 1));
  return frame;
}

/** `66 06 00 10 ss ck` — status query (ss=0), pause (1), resume (2), cancel (3). */
export function buildStatusFrame(sub: number = STATUS_SUB.SEARCH): Uint8Array {
  return buildFrame(CMD.STATUS, [sub & 0xff]);
}

/** `66 05 00 50 45` — firmware/hardware version query. */
export function buildFirmwareQueryFrame(): Uint8Array {
  return buildFrame(CMD.FIRMWARE, []);
}

export interface PrintBandParams {
  /** 1..31; 0 means "unset" and is sent as 31 like the SDK does */
  darkness: number;
  /** one of CLEARANCE.* */
  clearance: number;
  /** 0..7, see CUT_TYPE */
  cutType: number;
  /** 0..3, SaveLabelType (S1 feature); 0 for the E1 */
  saveType?: number;
  /** total number of copies in the job (printListCount * printCounts) */
  totalCopies: number;
  /** 1-based index of the copy being sent */
  copyIndex: number;
  /**
   * label LENGTH along the feed in dots (bytes 11-12). The printer cuts after this many rows
   * (hardware-confirmed on an E1: a 148-row label with 88 here was cut at row 88).
   */
  labelLengthDots: number;
  /** rows in this band (bytes 13-14) */
  bandRows: number;
  /** bands remaining after this one (byte 15) */
  bandsRemaining: number;
  /** LZO1X-1 compressed band */
  compressed: Uint8Array;
}

/**
 * Builds the 0x1B print-band frame. CONFIRMED layout
 * (OperateNewProtocolPrinterRunnable.operate1BCommand, see docs/PROTOCOL.md §8).
 */
export function buildPrintBandFrame(p: PrintBandParams): Uint8Array {
  const dark = p.darkness > 0 ? p.darkness & 0x1f : 0x1f;
  const clearance = p.clearance & 0xe0;
  const cut = p.cutType >= 0 ? p.cutType & 0x07 : 0x07;
  const save = ((p.saveType ?? 0) << 3) & 0x18;
  if (p.bandsRemaining < 0 || p.bandsRemaining > 0xff) {
    throw new Error(`bandsRemaining out of range: ${p.bandsRemaining}`);
  }
  const payload = new Uint8Array(13 + p.compressed.length);
  payload[0] = dark | clearance; // frame byte 4
  payload[1] = cut | save; // 5
  payload[2] = p.totalCopies & 0xff; // 6
  payload[3] = (p.totalCopies >> 8) & 0xff; // 7
  payload[4] = p.copyIndex & 0xff; // 8
  payload[5] = (p.copyIndex >> 8) & 0xff; // 9
  payload[6] = 0x01; // 10
  payload[7] = p.labelLengthDots & 0xff; // 11
  payload[8] = (p.labelLengthDots >> 8) & 0xff; // 12
  payload[9] = p.bandRows & 0xff; // 13
  payload[10] = (p.bandRows >> 8) & 0xff; // 14
  payload[11] = p.bandsRemaining & 0xff; // 15
  payload[12] = 0x00; // 16
  payload.set(p.compressed, 13); // 17..
  return buildFrame(CMD.PRINT_BAND, payload);
}

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

/** DPI code tables. CONFIRMED (CheckPrinterAttributeEvent / parsePrinterStatus). */
const H_DPI: Record<number, number> = { 0: 203, 1: 300, 2: 600, 3: 180, 4: 288 };
const V_DPI: Record<number, number> = { 1: 203, 2: 300, 3: 600, 4: 180, 5: 288 };

export type PrintPosition = 'left' | 'center' | 'right';

/** Status code (frame[4] & 0x3F) -> meaning. CONFIRMED (wewinPrinterParsingProtocol + doFindMessageByStatusId). */
export const STATUS_CODE_TEXT: Record<number, string> = {
  0: 'OK',
  1: 'no label cassette',
  2: 'data storage failure',
  3: 'label used up',
  4: 'label not recognised (use genuine consumable)',
  5: 'no label cassette',
  6: 'cover open / lock lever open',
  7: 'label not recognised',
  8: 'print head over-temperature',
  9: 'cutter jammed',
  10: 'ribbon abnormal',
  11: 'printer busy (menu / mode selection)',
  12: 'wrong power adapter',
  13: 'paper jam',
  14: 'printer off or in standby',
  15: 'label abnormal (gap setting)',
  16: 'job cancelled by printer (exit)',
  17: 'reprint requested',
  18: 'unlock and insert ribbon cassette',
  19: 'ribbon used up',
  20: 'unrecognised ribbon',
  21: 'print head fault',
  22: 'ribbon installed in thermal mode',
  23: 'OK',
};

export interface StatusFrame {
  raw: Uint8Array;
  /** frame[1] | frame[2] << 8 */
  declaredLength: number;
  /** frame[3] */
  commandEcho: number;
  checksumOk: boolean;
  /** frame[4] & 0x3F */
  statusCode: number;
  statusText: string;
  wait: boolean;
  resend: boolean;
  batteryPercent: number | null;
  charging: boolean | null;
  horizontalDpi: number | null;
  verticalDpi: number | null;
  hasCutter: boolean | null;
  hasBluetooth: boolean | null;
  hasWifi: boolean | null;
  hasRfid: boolean | null;
  darkness: number | null;
  /** frame[8..9], units unknown (ASSUMED) */
  labelHeight: number | null;
  printerType: string | null;
  labelRemainingLength: number | null;
  labelTotalLength: number | null;
  labelTypeNumber: string | null;
  ribbonNumber: number | null;
  printSpeed: number | null;
  /** frame[35] bits 5-6: 0 none, 1 pause requested, 3 cancel requested */
  requestType: 'none' | 'pause' | 'cancel' | 'unknown';
  printing: boolean | null;
  protocolVersion: number | null;
  printPosition: PrintPosition | null;
  exchangeHL: boolean | null;
  headWidthBytes: number | null;
  maxPrintRows: number | null;
}

function asciiField(raw: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < start + len && i < raw.length; i++) {
    const b = raw[i];
    s += b === 0 ? ' ' : String.fromCharCode(b);
  }
  return s.trim();
}

/**
 * Decodes a status frame (response to 0x10 and 0x1B). Fields that are not present in a short
 * frame are null. CONFIRMED offsets, see docs/PROTOCOL.md §6.
 */
export function parseStatusFrame(raw: Uint8Array): StatusFrame {
  const has = (n: number) => raw.length >= n;
  const b4 = has(5) ? raw[4] : 0;
  const statusCode = b4 & 0x3f;
  const requestBits = has(36) ? (raw[35] >> 5) & 0x03 : 0;
  let requestType: StatusFrame['requestType'] = 'none';
  if (has(36)) {
    requestType = requestBits === 1 ? 'pause' : requestBits === 3 ? 'cancel' : requestBits === 0 ? 'none' : 'unknown';
  }
  let protocolVersion: number | null = null;
  let printPosition: PrintPosition | null = null;
  let exchangeHL: boolean | null = null;
  let headWidthBytes: number | null = null;
  let maxPrintRows: number | null = null;
  if (has(43)) {
    protocolVersion = parseFloat(`${raw[36]}.${raw[37]}`);
    const pos = raw[38] & 0x03;
    printPosition = pos === 0 ? 'left' : pos === 2 ? 'right' : 'center';
    exchangeHL = ((raw[38] >> 2) & 1) === 1;
    headWidthBytes = raw[39] | (raw[40] << 8);
    maxPrintRows = raw[41] | (raw[42] << 8);
  }
  const vCode = has(16) ? raw[15] & 0x0f : null;
  return {
    raw,
    declaredLength: has(3) ? raw[1] | (raw[2] << 8) : raw.length,
    commandEcho: has(4) ? raw[3] : -1,
    checksumOk: verifyChecksum(raw),
    statusCode,
    statusText: STATUS_CODE_TEXT[statusCode] ?? `unknown status ${statusCode}`,
    wait: (b4 & 0x80) !== 0,
    resend: (b4 & 0x40) !== 0,
    batteryPercent: has(6) ? ((raw[5] & 0x7f) === 127 ? 100 : raw[5] & 0x7f) : null,
    charging: has(6) ? (raw[5] & 0x80) !== 0 : null,
    horizontalDpi: has(7) ? (H_DPI[raw[6] & 0x07] ?? null) : null,
    verticalDpi: vCode === null ? null : vCode === 0 ? null : (V_DPI[vCode] ?? null),
    hasCutter: has(7) ? (raw[6] & 0x08) !== 0 : null,
    hasBluetooth: has(7) ? (raw[6] & 0x10) !== 0 : null,
    hasWifi: has(7) ? (raw[6] & 0x20) !== 0 : null,
    hasRfid: has(7) ? (raw[6] & 0x40) !== 0 : null,
    darkness: has(8) ? raw[7] & 0x1f : null,
    labelHeight: has(10) ? raw[8] | (raw[9] << 8) : null,
    printerType: has(15) ? asciiField(raw, 10, 5) : null,
    labelRemainingLength: has(18) ? raw[16] | (raw[17] << 8) : null,
    labelTotalLength: has(20) ? raw[18] | (raw[19] << 8) : null,
    labelTypeNumber: has(34) ? asciiField(raw, 20, 14) : null,
    ribbonNumber: has(35) ? (raw[34] === 0xff ? -1 : raw[34] & 0x7f) : null,
    printSpeed: has(36) ? raw[35] & 0x0f : null,
    requestType,
    printing: has(36) ? (raw[35] & 0x80) !== 0 : null,
    protocolVersion,
    printPosition,
    exchangeHL,
    headWidthBytes,
    maxPrintRows,
  };
}

/** Response classes used by the print loop. CONFIRMED (wewinPrinterParsingProtocol.parsingResponseByteArray). */
export type ResponseClass = 'resnull' | 'resend' | 'wait' | 'error' | 'exit' | 'reprint' | 'pause' | 'success';

export function classifyResponse(raw: Uint8Array | null | undefined): ResponseClass {
  if (!raw || raw.length === 0) return 'resnull';
  if (raw.length < 36) {
    if (raw.length >= 6 && raw[3] === 0x11) return 'resnull'; // "occupied" frame 66 06 00 11 00 83
    return 'resend';
  }
  const code = raw[4] & 0x3f;
  if (code === 16) return 'exit';
  if (code === 17) return 'reprint';
  if (code !== 0 && code !== 23) return 'error';
  if ((raw[4] & 0x80) !== 0) return 'wait';
  if ((raw[4] & 0x40) !== 0) return 'resend';
  const req = (raw[35] >> 5) & 0x03;
  if (req === 1) return 'pause';
  if (req === 3) return 'exit';
  return 'success';
}

/** `66 06 00 11 00 83`: another host owns the printer. CONFIRMED (ConnectedListener). */
export function isOccupiedFrame(raw: Uint8Array): boolean {
  return raw.length === 6 && raw[0] === 0x66 && raw[1] === 0x06 && raw[2] === 0x00 && raw[3] === 0x11 && raw[4] === 0x00 && raw[5] === 0x83;
}

/** Printer is powering off: bytes 3..7 are '*'. CONFIRMED (ConnectedListener). */
export function isPowerOffFrame(raw: Uint8Array): boolean {
  if (raw.length < 9) return false;
  for (let i = 3; i <= 7; i++) if (raw[i] !== 0x2a) return false;
  return true;
}

/**
 * Parses the 0x50 response: from byte 4, NUL-terminated UTF-8 strings; [0] hardware, [1] firmware.
 * CONFIRMED (wewinPrinterOperateHelper.doOperateCheckPrinterFirmware).
 */
export function parseFirmwareResponse(raw: Uint8Array): string[] {
  const out: string[] = [];
  if (raw.length < 6) return out;
  const body = raw.subarray(4, raw.length - 1);
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0) {
      out.push(new TextDecoder().decode(body.subarray(start, i)).trim());
      start = i + 1;
    }
  }
  return out;
}

export interface PrinterAttributes {
  horizontalDpi: number;
  verticalDpi: number;
  protocolVersion: number | null;
  printPosition: PrintPosition;
  exchangeHL: boolean;
  headWidthBytes: number;
  maxPrintRows: number;
  hasRfid: boolean;
  printerType: string | null;
  /** true when the values came from the printer, false when SDK defaults were used */
  fromPrinter: boolean;
}

/**
 * SDK defaults applied when the printer does not report attributes
 * (wewinPrinterManager.restoreAllPrinterParams + getPrinterDefaultDpi for an unknown name).
 * CONFIRMED values; ASSUMED that they are right for the E1 -- always prefer the live query.
 */
export const SDK_DEFAULT_ATTRIBUTES: PrinterAttributes = {
  horizontalDpi: 203,
  verticalDpi: 203,
  protocolVersion: null,
  printPosition: 'center',
  exchangeHL: true,
  headWidthBytes: 72,
  maxPrintRows: 56,
  hasRfid: false,
  printerType: null,
  fromPrinter: false,
};

/**
 * Mirrors CheckPrinterAttributeEvent: only a response with cmd echo 0x10 and a declared length
 * equal to the actual length is accepted; the >=1.3 fields are taken only when present.
 */
export function attributesFromStatus(s: StatusFrame): PrinterAttributes | null {
  if (s.commandEcho !== CMD.STATUS) return null;
  if (s.declaredLength !== s.raw.length && (s.declaredLength & 0xff) !== s.raw.length) return null;
  const hDpi = s.horizontalDpi ?? SDK_DEFAULT_ATTRIBUTES.horizontalDpi;
  const attrs: PrinterAttributes = {
    ...SDK_DEFAULT_ATTRIBUTES,
    horizontalDpi: hDpi,
    verticalDpi: s.verticalDpi ?? hDpi,
    hasRfid: s.hasRfid ?? false,
    printerType: s.printerType,
    fromPrinter: true,
  };
  if (s.protocolVersion !== null && s.protocolVersion >= 1.3) {
    attrs.protocolVersion = s.protocolVersion;
    attrs.printPosition = s.printPosition ?? 'center';
    attrs.exchangeHL = s.exchangeHL ?? true;
    attrs.headWidthBytes = s.headWidthBytes || SDK_DEFAULT_ATTRIBUTES.headWidthBytes;
    attrs.maxPrintRows = s.maxPrintRows || SDK_DEFAULT_ATTRIBUTES.maxPrintRows;
  } else {
    attrs.protocolVersion = s.protocolVersion;
  }
  return attrs;
}

/** Human-readable one-line description of an outgoing frame, for the console. */
export function describeFrame(frame: Uint8Array): string {
  if (frame.length < 4 || frame[0] !== START_BYTE) return 'raw bytes';
  const cmd = frame[3];
  switch (cmd) {
    case CMD.STATUS: {
      const sub = frame[4];
      const name = sub === 0 ? 'status/search' : sub === 1 ? 'pause' : sub === 2 ? 'resume' : sub === 3 ? 'cancel' : `sub ${sub}`;
      return `0x10 ${name}`;
    }
    case CMD.FIRMWARE:
      return '0x50 firmware/hardware query';
    case CMD.PRINT_BAND: {
      const dark = frame[4] & 0x1f;
      const clr = frame[4] & 0xe0;
      const cut = frame[5] & 0x07;
      const total = frame[6] | (frame[7] << 8);
      const idx = frame[8] | (frame[9] << 8);
      const h = frame[11] | (frame[12] << 8);
      const rows = frame[13] | (frame[14] << 8);
      const rem = frame[15];
      return `0x1B band copy ${idx}/${total} rows=${rows} remaining=${rem} length=${h} dark=${dark} clearance=0x${clr.toString(16)} cut=${cut} lzo=${frame.length - 18}B`;
    }
    case CMD.RFID_WRITE:
      return '0x1A RFID write';
    default:
      return `cmd 0x${cmd.toString(16)}`;
  }
}
