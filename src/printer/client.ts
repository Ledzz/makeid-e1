/**
 * Protocol client for MakeID E1 / wewin new-protocol printers.
 * Talks to a Transport, knows nothing about the UI. No DOM access.
 *
 * Timing and retry behaviour mirrors the MakeID-Life SDK (docs/PROTOCOL.md §5, §11).
 */
import {
  attributesFromStatus,
  buildFirmwareQueryFrame,
  buildStatusFrame,
  classifyResponse,
  describeFrame,
  isOccupiedFrame,
  isPowerOffFrame,
  parseFirmwareResponse,
  parseStatusFrame,
  SDK_DEFAULT_ATTRIBUTES,
  STATUS_SUB,
  type PrinterAttributes,
  type ResponseClass,
  type StatusFrame,
} from './frames.ts';
import { planPrintJob, type PlannedFrame, type PrintJobOptions, type PrintPlan } from './job.ts';
import { ResponseReassembler } from './reassembler.ts';
import type { MonoImage } from './raster.ts';
import { chunkFrame, type Transport } from './transport.ts';
import { toHex } from './hex.ts';

export type LogLevel = 'info' | 'tx' | 'rx' | 'warn' | 'error';

export interface ClientEvents {
  log: (level: LogLevel, message: string) => void;
  status: (status: StatusFrame) => void;
  progress: (info: { copy: number; copies: number; band: number; bands: number }) => void;
  disconnected: (reason: string) => void;
}

export interface ClientOptions {
  /** ms to wait for a status response to 0x10 handshakes and 0x1B bands (SDK: 10000) */
  printResponseTimeoutMs?: number;
  /** ms to wait for other responses (SDK default when 0 is passed: 5000) */
  responseTimeoutMs?: number;
  /** delay between connect and the first attribute query (SDK: 200) */
  connectSettleMs?: number;
  /** stop after this many consecutive "resend" answers to the same frame */
  maxResends?: number;
}

export interface PrintProgressCallbacks {
  onProgress?: ClientEvents['progress'];
  shouldCancel?: () => boolean;
}

export class PrinterClient {
  attributes: PrinterAttributes = { ...SDK_DEFAULT_ATTRIBUTES };
  lastStatus: StatusFrame | null = null;
  firmware: string[] = [];
  private readonly reassembler: ResponseReassembler;
  private pendingResolve: ((frame: Uint8Array) => void) | null = null;
  private busy = false;
  private readonly listeners: { [K in keyof ClientEvents]: Set<ClientEvents[K]> } = {
    log: new Set(),
    status: new Set(),
    progress: new Set(),
    disconnected: new Set(),
  };
  private readonly opts: Required<ClientOptions>;

  readonly transport: Transport;

  constructor(transport: Transport, opts: ClientOptions = {}, flavour: 'new' | 'old' = 'new') {
    this.transport = transport;
    this.opts = {
      printResponseTimeoutMs: opts.printResponseTimeoutMs ?? 10000,
      responseTimeoutMs: opts.responseTimeoutMs ?? 5000,
      connectSettleMs: opts.connectSettleMs ?? 200,
      maxResends: opts.maxResends ?? 20,
    };
    this.reassembler = new ResponseReassembler(flavour);
    transport.onNotify((data) => this.handleNotify(data));
    transport.onDisconnect((reason) => {
      this.pendingResolve = null;
      this.reassembler.reset();
      this.emit('disconnected', reason);
    });
  }

  on<K extends keyof ClientEvents>(event: K, handler: ClientEvents[K]): () => void {
    (this.listeners[event] as Set<ClientEvents[K]>).add(handler);
    return () => (this.listeners[event] as Set<ClientEvents[K]>).delete(handler);
  }

  private emit<K extends keyof ClientEvents>(event: K, ...args: Parameters<ClientEvents[K]>): void {
    for (const h of this.listeners[event]) (h as (...a: Parameters<ClientEvents[K]>) => void)(...args);
  }

  private log(level: LogLevel, message: string): void {
    this.emit('log', level, message);
  }

  get isDryRun(): boolean {
    return this.transport.kind === 'dryrun';
  }

  private handleNotify(data: Uint8Array): void {
    this.log('rx', `notify ${data.length} B: ${toHex(data)}`);
    const frame = this.reassembler.push(data);
    if (!frame) return;
    if (isPowerOffFrame(frame)) {
      this.log('warn', 'printer reports power-off ("*****")');
    } else if (isOccupiedFrame(frame)) {
      this.log('warn', 'printer is occupied by another host (66 06 00 11 00 83)');
    } else if (frame.length >= 5 && frame[0] === 0x66 && frame[3] === 0x10) {
      const st = parseStatusFrame(frame);
      this.lastStatus = st;
      this.emit('status', st);
      this.log('rx', `status: ${summarizeStatus(st)}`);
    }
    const resolve = this.pendingResolve;
    if (resolve) {
      this.pendingResolve = null;
      resolve(frame);
    } else {
      this.log('rx', `unsolicited frame (${frame.length} B): ${toHex(frame)}`);
    }
  }

  /**
   * Sends one frame (chunked) and waits for exactly one reassembled response.
   * In dry-run mode the frame is logged and null is returned immediately.
   */
  async exchange(frame: Uint8Array, timeoutMs: number, label = describeFrame(frame)): Promise<Uint8Array | null> {
    this.log('tx', `${label} (${frame.length} B): ${toHex(frame)}`);
    if (this.isDryRun) {
      for (const chunk of chunkFrame(frame, this.transport.chunkSize)) await this.transport.write(chunk);
      return null;
    }
    if (this.busy) throw new Error('another exchange is in progress');
    this.busy = true;
    try {
      this.reassembler.reset();
      const responsePromise = new Promise<Uint8Array | null>((resolve) => {
        const timer = setTimeout(() => {
          if (this.pendingResolve === wrapped) {
            this.pendingResolve = null;
            this.log('warn', `no response within ${timeoutMs} ms`);
            resolve(null);
          }
        }, timeoutMs);
        const wrapped = (f: Uint8Array) => {
          clearTimeout(timer);
          resolve(f);
        };
        this.pendingResolve = wrapped;
      });
      const chunks = chunkFrame(frame, this.transport.chunkSize);
      for (const chunk of chunks) await this.transport.write(chunk);
      if (chunks.length > 1) this.log('info', `sent in ${chunks.length} chunks of <= ${this.transport.chunkSize} B`);
      return await responsePromise;
    } finally {
      this.busy = false;
    }
  }

  /** `66 06 00 10 00 84` — status query; also used as heartbeat. */
  async queryStatus(): Promise<StatusFrame | null> {
    const raw = await this.exchange(buildStatusFrame(STATUS_SUB.SEARCH), this.opts.responseTimeoutMs);
    if (!raw) return null;
    return parseStatusFrame(raw);
  }

  /**
   * Connect-time attribute query (SDK CheckPrinterAttributeEvent): up to 3 attempts, 200 ms apart,
   * accepting only a 0x10 echo whose declared length matches. Updates `attributes`.
   */
  async queryAttributes(): Promise<PrinterAttributes> {
    if (this.isDryRun) {
      await this.exchange(buildStatusFrame(STATUS_SUB.SEARCH), 0, '0x10 status/attribute query (dry run: no response expected)');
      this.log('info', `dry run: using assumed attributes ${describeAttributes(this.attributes)}`);
      return this.attributes;
    }
    await sleep(this.opts.connectSettleMs);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = await this.exchange(buildStatusFrame(STATUS_SUB.SEARCH), this.opts.responseTimeoutMs, `0x10 attribute query (attempt ${attempt}/3)`);
      if (raw) {
        const st = parseStatusFrame(raw);
        const attrs = attributesFromStatus(st);
        if (attrs) {
          this.attributes = attrs;
          this.log('info', `printer attributes: ${describeAttributes(attrs)}`);
          if (attrs.protocolVersion === null || attrs.protocolVersion < 1.3) {
            this.log('warn', `printer did not report protocol >= 1.3 (got ${attrs.protocolVersion ?? 'none'}); head width / band rows are SDK defaults, NOT from the printer (see PROTOCOL.md §9)`);
          }
          return attrs;
        }
        this.log('warn', `attribute response rejected (echo 0x${st.commandEcho.toString(16)}, declared ${st.declaredLength}, got ${raw.length})`);
      }
      await sleep(200);
    }
    this.log('warn', 'attribute query failed 3 times; keeping SDK defaults');
    return this.attributes;
  }

  /** `66 05 00 50 45` — hardware/firmware strings. */
  async queryFirmware(): Promise<string[]> {
    const raw = await this.exchange(buildFirmwareQueryFrame(), this.opts.responseTimeoutMs);
    if (!raw) return [];
    const strings = parseFirmwareResponse(raw);
    this.firmware = strings;
    this.log('info', `firmware response: ${strings.length ? strings.map((s) => JSON.stringify(s)).join(', ') : '(no strings)'}`);
    return strings;
  }

  async pause(): Promise<ResponseClass> {
    return this.statusCommand(STATUS_SUB.PAUSE, '0x10 pause');
  }

  async resume(): Promise<ResponseClass> {
    return this.statusCommand(STATUS_SUB.RESTORE, '0x10 resume');
  }

  /** `66 06 00 10 03 81`, repeated while the printer answers "resend" (SDK operateCancelCommand). */
  async cancel(): Promise<ResponseClass> {
    let cls: ResponseClass = 'resend';
    let tries = 0;
    while (cls === 'resend' && tries++ < this.opts.maxResends) {
      cls = await this.statusCommand(STATUS_SUB.CANCEL, '0x10 cancel');
    }
    return cls;
  }

  private async statusCommand(sub: number, label: string): Promise<ResponseClass> {
    const raw = await this.exchange(buildStatusFrame(sub), this.opts.responseTimeoutMs, label);
    if (this.isDryRun) return 'success';
    return classifyResponse(raw);
  }

  /** Builds the frame plan without sending anything. */
  plan(label: MonoImage, options: Partial<PrintJobOptions> = {}): PrintPlan {
    return planPrintJob(label, this.attributes, options);
  }

  /**
   * Executes a print plan following OperateNewProtocolPrinterRunnable.run():
   *  - `restore` until not resend
   *  - per copy: handshake loop (resend/pause/error/wait), then bands with wait-polling
   * In dry-run mode every frame is logged and nothing waits for responses.
   */
  async print(plan: PrintPlan, cb: PrintProgressCallbacks = {}): Promise<'done' | 'cancelled' | 'error'> {
    const copies = plan.frames.filter((f) => f.kind === 'handshake').length;
    const bands = plan.raster.bands.length;
    this.log('info', `print job: ${copies} cop${copies === 1 ? 'y' : 'ies'}, ${bands} band(s), ${plan.raster.wireImage.width}x${plan.raster.lengthDots} dots on the wire, ${plan.totalBytes} B total`);
    for (const f of plan.frames) {
      if (cb.shouldCancel?.()) {
        this.log('warn', 'cancel requested by user');
        if (!this.isDryRun) await this.cancel();
        return 'cancelled';
      }
      if (f.kind === 'band') {
        this.emit('progress', { copy: f.copy ?? 1, copies, band: (f.band ?? 0) + 1, bands });
        cb.onProgress?.({ copy: f.copy ?? 1, copies, band: (f.band ?? 0) + 1, bands });
      }
      const result = await this.sendPlanned(f);
      if (result === 'exit') {
        this.log('warn', 'printer cancelled the job');
        return 'cancelled';
      }
      if (result === 'error') return 'error';
    }
    this.log('info', 'print job complete (no end-of-job frame exists in this protocol)');
    return 'done';
  }

  private async sendPlanned(f: PlannedFrame): Promise<'ok' | 'exit' | 'error'> {
    const timeout = this.opts.printResponseTimeoutMs;
    if (this.isDryRun) {
      await this.exchange(f.bytes, 0, `[${f.kind}] ${f.note}`);
      return 'ok';
    }
    let resends = 0;
    for (;;) {
      const raw = await this.exchange(f.bytes, timeout, `[${f.kind}] ${f.note}`);
      let cls = classifyResponse(raw);
      if (cls === 'resnull') {
        if (f.kind === 'restore') return 'ok'; // SDK only loops on "resend" here
        this.log('error', 'no usable response from printer');
        return 'error';
      }
      if (cls === 'resend') {
        if (++resends > this.opts.maxResends) {
          this.log('error', `printer kept asking for a resend (${resends} times)`);
          return 'error';
        }
        this.log('warn', 'printer asked for a resend');
        continue;
      }
      if (f.kind === 'restore') return 'ok';
      // wait: poll 0x10 search until the wait bit clears (SDK behaviour for bands and handshakes)
      let polls = 0;
      while (cls === 'wait' || (f.kind === 'handshake' && cls === 'pause')) {
        if (++polls > 600) {
          this.log('error', 'printer stayed busy for too long');
          return 'error';
        }
        await sleep(cls === 'pause' ? 500 : 50);
        const r2 = await this.exchange(buildStatusFrame(STATUS_SUB.SEARCH), timeout, cls === 'pause' ? '0x10 poll (printer paused)' : '0x10 poll (printer busy)');
        cls = classifyResponse(r2);
        if (cls === 'resend') cls = 'wait';
      }
      if (cls === 'exit') return 'exit';
      if (cls === 'error') {
        const st = raw ? parseStatusFrame(raw) : null;
        this.log('error', `printer error: ${st ? `${st.statusCode} ${st.statusText}` : 'unknown'}`);
        return 'error';
      }
      if (cls === 'reprint') {
        this.log('warn', 'printer requested a reprint; resending frame');
        continue;
      }
      return 'ok';
    }
  }
}

export function summarizeStatus(st: StatusFrame): string {
  const parts: string[] = [];
  parts.push(`code ${st.statusCode} (${st.statusText})`);
  if (st.wait) parts.push('WAIT');
  if (st.resend) parts.push('RESEND');
  if (st.batteryPercent !== null) parts.push(`battery ${st.batteryPercent}%${st.charging ? ' charging' : ''}`);
  if (st.printing) parts.push('printing');
  if (st.requestType !== 'none') parts.push(`request=${st.requestType}`);
  if (st.horizontalDpi !== null) parts.push(`${st.horizontalDpi}dpi`);
  if (st.printerType) parts.push(`type="${st.printerType}"`);
  if (st.protocolVersion !== null) parts.push(`proto ${st.protocolVersion}`);
  if (st.headWidthBytes !== null) parts.push(`head ${st.headWidthBytes}B=${st.headWidthBytes * 8}dots`);
  if (st.maxPrintRows !== null) parts.push(`maxRows ${st.maxPrintRows}`);
  if (st.exchangeHL !== null) parts.push(`swapHL=${st.exchangeHL}`);
  if (st.printPosition) parts.push(`pos=${st.printPosition}`);
  if (!st.checksumOk) parts.push('BAD CHECKSUM');
  return parts.join(', ');
}

export function describeAttributes(a: PrinterAttributes): string {
  return `${a.fromPrinter ? 'from printer' : 'SDK defaults'}: ${a.horizontalDpi}x${a.verticalDpi} dpi, head ${a.headWidthBytes} B = ${a.headWidthBytes * 8} dots, ${a.maxPrintRows} rows/band, position ${a.printPosition}, swapHL ${a.exchangeHL}, protocol ${a.protocolVersion ?? 'n/a'}${a.printerType ? `, type "${a.printerType}"` : ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
