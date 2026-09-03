/** localStorage persistence for settings, recent labels and the remembered printer. */
import { CLEARANCE, CUT_TYPE } from '../printer/frames.ts';
import { DEFAULT_SPEC, type LabelSpec } from './editor.ts';

const KEY_SETTINGS = 'makeid-e1:settings:v1';
const KEY_RECENT = 'makeid-e1:recent:v1';
const KEY_DEVICE = 'makeid-e1:device:v1';

export const MAX_RECENT = 20;

export interface Settings {
  spec: LabelSpec;
  copies: number;
  darkness: number;
  cutType: number;
  clearance: number;
  flip180: boolean;
  chunkSize: number;
  writeMode: 'auto' | 'with-response' | 'without-response';
  acceptAll: boolean;
  headBytes: number;
  maxRows: number;
  position: 'left' | 'center' | 'right';
  swapHL: boolean;
  zoom: number;
  /** test mode = dry run: nothing is transmitted */
  testMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  spec: { ...DEFAULT_SPEC, text: '' },
  copies: 1,
  darkness: 15,
  cutType: CUT_TYPE.MULTIPLE,
  clearance: CLEARANCE.DDF,
  flip180: false,
  chunkSize: 20,
  writeMode: 'auto',
  acceptAll: false,
  headBytes: 12,
  maxRows: 170,
  position: 'center',
  swapHL: false,
  zoom: 2,
  testMode: false,
};

export interface RecentLabel {
  text: string;
  tapeWidthMm: number;
  fontSizeDots: number;
  rotateText: boolean;
  lengthMm: number | null;
  bold: boolean;
  printedAt: number;
  count: number;
}

export interface RememberedDevice {
  id: string;
  name: string;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: ignore */
  }
}

export function loadSettings(): Settings {
  const stored = read<Partial<Settings>>(KEY_SETTINGS) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored, spec: { ...DEFAULT_SETTINGS.spec, ...(stored.spec ?? {}) } };
}

export function saveSettings(s: Settings): void {
  write(KEY_SETTINGS, s);
}

export function loadRecent(): RecentLabel[] {
  const list = read<RecentLabel[]>(KEY_RECENT) ?? [];
  return list.filter((r) => r && typeof r.text === 'string');
}

/** Adds (or bumps) a label; most recent first, deduplicated by text + tape + size + rotation. */
export function addRecent(entry: Omit<RecentLabel, 'printedAt' | 'count'>): RecentLabel[] {
  const list = loadRecent();
  const same = (r: RecentLabel) => r.text === entry.text && r.tapeWidthMm === entry.tapeWidthMm && r.fontSizeDots === entry.fontSizeDots && r.rotateText === entry.rotateText && r.lengthMm === entry.lengthMm;
  const existing = list.find(same);
  const next = list.filter((r) => !same(r));
  next.unshift({ ...entry, printedAt: Date.now(), count: (existing?.count ?? 0) + 1 });
  const trimmed = next.slice(0, MAX_RECENT);
  write(KEY_RECENT, trimmed);
  return trimmed;
}

export function removeRecent(index: number): RecentLabel[] {
  const list = loadRecent();
  list.splice(index, 1);
  write(KEY_RECENT, list);
  return list;
}

export function clearRecent(): void {
  write(KEY_RECENT, []);
}

export function loadDevice(): RememberedDevice | null {
  return read<RememberedDevice>(KEY_DEVICE);
}

export function saveDevice(d: RememberedDevice | null): void {
  if (d) write(KEY_DEVICE, d);
  else localStorage.removeItem(KEY_DEVICE);
}
