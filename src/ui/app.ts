/**
 * UI wiring. Everything DOM-related lives here and in editor.ts / console.ts / storage.ts.
 * The printer driver (src/printer) is used as a black box.
 */
import { PrinterClient, describeAttributes, summarizeStatus } from '../printer/client.ts';
import { CLEARANCE, CUT_TYPE, SDK_DEFAULT_ATTRIBUTES, type PrinterAttributes, type StatusFrame } from '../printer/frames.ts';
import { toHex } from '../printer/hex.ts';
import type { PrintPlan } from '../printer/job.ts';
import { lzo1xDecompress } from '../printer/lzo1x.ts';
import { DryRunTransport, type Transport } from '../printer/transport.ts';
import { isWebBluetoothAvailable, requestPrinterDevice, WebBluetoothTransport } from '../printer/webbluetooth.ts';
import { UiConsole } from './console.ts';
import { MAX_LENGTH_MM, MIN_LENGTH_MM, TAPES, dotsToMm, monoToCanvas, renderLabel, type Align, type LabelSpec, type RenderedLabel } from './editor.ts';
import { addRecent, clearRecent, loadDevice, loadRecent, loadSettings, removeRecent, saveDevice, saveSettings, type RecentLabel, type Settings } from './storage.ts';

interface QueueItem {
  text: string;
  state: 'pending' | 'active' | 'done' | 'failed';
}

type ConnState = 'off' | 'searching' | 'connecting' | 'on' | 'error';

export class App {
  private root: HTMLElement;
  private consoleUi!: UiConsole;
  private client: PrinterClient;
  private transport: Transport;
  private bleTransport: WebBluetoothTransport | null = null;
  private settings: Settings;
  private spec: LabelSpec;
  private rendered: RenderedLabel | null = null;
  private plan: PrintPlan | null = null;
  private queue: QueueItem[] = [];
  private recent: RecentLabel[] = loadRecent();
  private printing = false;
  private cancelRequested = false;
  private heartbeat: number | null = null;
  private els: Record<string, HTMLElement> = {};
  private connState: ConnState = 'off';
  private connText = 'Not connected';
  private lastMessage: { level: 'info' | 'warn' | 'error'; text: string } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.settings = loadSettings();
    this.spec = { ...this.settings.spec };
    this.transport = new DryRunTransport();
    this.transport.chunkSize = this.settings.chunkSize;
    this.client = this.makeClient(this.transport);
    this.build();
    this.applySettingsToInputs();
    this.readInputs();
    this.updateAll();
    this.renderRecent();
    if (this.settings.testMode) this.log('info', 'Test mode is on: nothing is sent to the printer.');
    if (!isWebBluetoothAvailable()) {
      this.setMessage('warn', 'This browser has no Web Bluetooth. Use Chrome or Edge over HTTPS or localhost.');
    } else {
      void this.tryAutoReconnect();
    }
  }

  // ------------------------------------------------------------------ construction

  private build(): void {
    this.root.innerHTML = `
      <header class="top">
        <h1>E1 label printer</h1>
        <div class="conn">
          <span class="status" id="connStatus">Not connected</span>
          <button class="primary" id="connectBtn">Connect printer</button>
          <button id="disconnectBtn" hidden>Disconnect</button>
        </div>
      </header>
      <main>
        <div class="col">
          <div class="message" id="message" hidden></div>

          <section class="panel" id="recentPanel" hidden>
            <h2>Recent labels</h2>
            <div class="row" id="recentList"></div>
            <p class="small" id="recentEmpty">Labels you print will appear here for one-click reprinting.</p>
          </section>

          <section class="panel">
            <h2>Label</h2>
            <textarea id="text" rows="2" spellcheck="false" autocapitalize="off" autocorrect="off" enterkeyhint="done" placeholder="Type the label text…"></textarea>
            <div class="preview-wrap"><canvas class="preview" id="labelCanvas"></canvas></div>
            <div class="preview-meta" id="labelMeta"></div>
            <details class="opts" id="labelOpts">
              <summary>Text &amp; tape options</summary>
              <div class="row">
                <label><span class="lbl">tape</span><select id="tape"></select></label>
                <label><span class="lbl">text size</span><input type="number" id="fontSize" min="8" max="200" inputmode="numeric" /></label>
                <label><span class="lbl">font</span>
                  <select id="fontFamily">
                    <option value='ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'>monospace</option>
                    <option value='"Courier New", Courier, monospace'>Courier New</option>
                    <option value='system-ui, sans-serif'>sans-serif</option>
                  </select>
                </label>
                <label><span class="lbl">align</span><select id="align"><option value="center">center</option><option value="left">left</option><option value="right">right</option></select></label>
              </div>
              <div class="row">
                <label><span class="lbl">length</span><select id="lengthMode"><option value="auto">fit text</option><option value="fixed">fixed</option></select></label>
                <label><span class="lbl">length (mm)</span><input type="number" id="lengthMm" min="${MIN_LENGTH_MM}" max="${MAX_LENGTH_MM}" inputmode="numeric" /></label>
                <label><span class="lbl">side margin (mm)</span><input type="number" id="marginMm" min="0" max="50" step="0.5" inputmode="decimal" /></label>
              </div>
              <div class="row checks">
                <label class="inline"><input type="checkbox" id="bold" /> bold</label>
                <label class="inline"><input type="checkbox" id="rotateText" /> vertical text</label>
                <label class="inline"><input type="checkbox" id="flip180" /> upside down</label>
                <label class="inline"><input type="checkbox" id="invert" /> white on black</label>
                <label class="inline"><input type="checkbox" id="dither" /> dither (emoji, photos)</label>
              </div>
            </details>
            <div class="actions">
              <div class="row print-row">
                <label><span class="lbl">copies</span><input type="number" id="copies" min="1" max="99" inputmode="numeric" /></label>
                <label><span class="lbl">darkness</span>
                  <select id="darkness"><option value="10">light</option><option value="15">normal</option><option value="20">dark</option></select>
                </label>
                <label><span class="lbl">cut</span>
                  <select id="cutType">
                    <option value="${CUT_TYPE.MULTIPLE}">at the end</option>
                    <option value="${CUT_TYPE.SINGLE}">each copy</option>
                  </select>
                </label>
                <button class="primary big" id="printBtn">Print</button>
                <button id="cancelBtn" hidden>Cancel</button>
              </div>
              <div class="progress"><div id="progressBar"></div></div>
            </div>
          </section>

          <section class="panel">
            <h2>Print a list</h2>
            <textarea id="batchText" rows="3" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="One label per line"></textarea>
            <div class="row">
              <button id="batchLoadBtn">Add to queue</button>
              <button class="primary" id="batchPrintBtn" disabled>Print queue</button>
              <button id="batchClearBtn">Clear</button>
            </div>
            <ul class="queue" id="queueList"></ul>
          </section>
        </div>

        <div class="col">
          <details class="panel" id="advanced">
            <summary>Advanced &amp; diagnostics</summary>
            <div class="mode" id="modeBox">
              <label class="inline"><input type="checkbox" id="testMode" /> Test mode &mdash; preview and log frames only, nothing is sent to the printer</label>
            </div>
            <h2>Printer</h2>
            <dl class="kv" id="printerInfo"></dl>
            <div class="row">
              <button id="statusBtn" disabled>Query status</button>
              <button id="firmwareBtn" disabled>Query firmware</button>
              <button id="forgetBtn">Forget printer</button>
              <label class="inline"><input type="checkbox" id="heartbeatToggle" /> poll status every 1 s</label>
            </div>
            <div class="row">
              <label class="inline"><input type="checkbox" id="acceptAll" /> show all BLE devices when choosing</label>
              <label><span class="lbl">write chunk (bytes)</span><input type="number" id="chunkSize" min="1" max="512" /></label>
              <label><span class="lbl">write mode</span>
                <select id="writeMode"><option value="auto">characteristic default</option><option value="with-response">with response</option><option value="without-response">without response</option></select>
              </label>
            </div>
            <h2>Fallback printer attributes (used until the printer reports its own)</h2>
            <div class="row">
              <label><span class="lbl">head width (bytes)</span><input type="number" id="headBytes" min="1" max="255" /></label>
              <label><span class="lbl">rows per band</span><input type="number" id="maxRows" min="1" max="4096" /></label>
              <label><span class="lbl">position</span><select id="position"><option value="center">center</option><option value="left">left</option><option value="right">right</option></select></label>
              <label class="inline"><input type="checkbox" id="swapHL" /> swap byte pairs</label>
              <label><span class="lbl">tape mode</span>
                <select id="clearance">
                  <option value="${CLEARANCE.DDF}">continuous tape (0x20)</option>
                  <option value="${CLEARANCE.TRANSLUCENT}">die-cut / gap labels (0x00)</option>
                  <option value="${CLEARANCE.BLACKMARK}">black mark (0x40)</option>
                  <option value="${CLEARANCE.NONE}">none (0xE0)</option>
                </select>
              </label>
            </div>
            <h2>Wire image (as sent: head width &times; feed length)</h2>
            <div class="row"><label><span class="lbl">zoom</span><select id="zoom"><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option><option value="4">4x</option></select></label></div>
            <div class="preview-wrap" style="max-height:260px"><canvas class="preview" id="wireCanvas"></canvas></div>
            <div class="preview-meta" id="wireMeta"></div>
            <h2>Console</h2>
            <div class="row">
              <button id="clearConsoleBtn">Clear</button>
              <button id="copyConsoleBtn">Copy</button>
              <button id="dumpPlanBtn">Dump frame plan</button>
              <label class="inline"><input type="checkbox" id="autoScroll" checked /> auto-scroll</label>
              <label class="inline"><input type="checkbox" id="verifyLzo" checked /> verify LZO in dump</label>
            </div>
            <div class="console" id="console"></div>
          </details>
        </div>
      </main>
    `;
    for (const id of [
      'connStatus', 'connectBtn', 'disconnectBtn', 'modeBox', 'testMode', 'message', 'recentPanel', 'recentList', 'recentEmpty', 'text', 'tape', 'fontSize', 'fontFamily', 'bold',
      'align', 'lengthMode', 'lengthMm', 'marginMm', 'rotateText', 'flip180', 'invert', 'dither', 'labelOpts', 'labelCanvas', 'labelMeta', 'copies', 'darkness', 'cutType', 'printBtn',
      'cancelBtn', 'progressBar', 'batchText', 'batchLoadBtn', 'batchPrintBtn', 'batchClearBtn', 'queueList', 'advanced', 'printerInfo', 'statusBtn', 'firmwareBtn',
      'forgetBtn', 'heartbeatToggle', 'acceptAll', 'chunkSize', 'writeMode', 'headBytes', 'maxRows', 'position', 'swapHL', 'clearance', 'zoom', 'wireCanvas', 'wireMeta',
      'clearConsoleBtn', 'copyConsoleBtn', 'dumpPlanBtn', 'autoScroll', 'verifyLzo', 'console',
    ]) {
      const el = this.root.querySelector<HTMLElement>(`#${id}`);
      if (!el) throw new Error(`missing element #${id}`);
      this.els[id] = el;
    }
    this.consoleUi = new UiConsole(this.els.console);

    const tapeSel = this.els.tape as HTMLSelectElement;
    for (const t of TAPES) {
      const o = document.createElement('option');
      o.value = String(t.widthMm);
      o.textContent = `${t.widthMm} mm`;
      tapeSel.append(o);
    }

    for (const id of ['text', 'fontSize', 'fontFamily', 'bold', 'invert', 'dither', 'align', 'rotateText', 'flip180', 'tape', 'lengthMode', 'lengthMm', 'marginMm', 'copies', 'darkness', 'cutType', 'clearance', 'zoom', 'headBytes', 'maxRows', 'position', 'swapHL', 'acceptAll', 'chunkSize', 'writeMode']) {
      this.els[id].addEventListener('input', () => {
        this.readInputs();
        this.updateAll();
        this.persist();
      });
    }

    this.els.testMode.addEventListener('change', () => this.setTestMode((this.els.testMode as HTMLInputElement).checked));
    this.els.connectBtn.addEventListener('click', () => void this.connectInteractive());
    this.els.disconnectBtn.addEventListener('click', () => void this.disconnect());
    this.els.forgetBtn.addEventListener('click', () => {
      saveDevice(null);
      this.setMessage('info', 'Printer forgotten. Use "Connect printer" to choose one.');
    });
    this.els.statusBtn.addEventListener('click', () => void this.client.queryStatus());
    this.els.firmwareBtn.addEventListener('click', () => void this.client.queryFirmware().then(() => this.updatePrinterInfo()));
    this.els.heartbeatToggle.addEventListener('change', () => this.setHeartbeat((this.els.heartbeatToggle as HTMLInputElement).checked));
    this.els.printBtn.addEventListener('click', () => void this.printCurrent());
    this.els.printBtn.addEventListener('pointerdown', () => (this.cancelRequested = false));
    this.els.batchPrintBtn.addEventListener('pointerdown', () => (this.cancelRequested = false));
    this.els.cancelBtn.addEventListener('click', () => {
      this.cancelRequested = true;
      this.log('warn', 'cancel requested');
    });
    this.els.batchLoadBtn.addEventListener('click', () => this.loadBatch());
    this.els.batchPrintBtn.addEventListener('click', () => void this.printQueue());
    this.els.batchClearBtn.addEventListener('click', () => {
      this.queue = [];
      this.renderQueue();
    });
    this.els.clearConsoleBtn.addEventListener('click', () => this.consoleUi.clear());
    this.els.copyConsoleBtn.addEventListener('click', () => void navigator.clipboard?.writeText(this.consoleUi.text()));
    this.els.dumpPlanBtn.addEventListener('click', () => this.dumpPlan());
    this.els.autoScroll.addEventListener('change', () => (this.consoleUi.autoScroll = (this.els.autoScroll as HTMLInputElement).checked));
    this.els.text.addEventListener('keydown', (ev) => {
      const k = ev as KeyboardEvent;
      if (k.key === 'Enter' && (k.metaKey || k.ctrlKey)) {
        ev.preventDefault();
        void this.printCurrent();
      }
    });

    // The options are a distraction on a phone; on a wide screen there is room for them.
    (this.els.labelOpts as HTMLDetailsElement).open = window.matchMedia('(min-width: 760px)').matches;
    window.addEventListener('resize', () => this.layoutPreviews());
  }

  private makeClient(transport: Transport): PrinterClient {
    const client = new PrinterClient(transport, {}, this.bleTransport?.flavour ?? 'new');
    client.attributes = this.assumedAttributes();
    client.on('log', (level, msg) => this.log(level, msg));
    client.on('status', (st) => this.onStatus(st));
    client.on('disconnected', (reason) => this.onDisconnected(reason));
    return client;
  }

  private assumedAttributes(): PrinterAttributes {
    return {
      ...SDK_DEFAULT_ATTRIBUTES,
      headWidthBytes: this.settings.headBytes,
      maxPrintRows: this.settings.maxRows,
      printPosition: this.settings.position,
      exchangeHL: this.settings.swapHL,
      fromPrinter: false,
    };
  }

  // ------------------------------------------------------------------ settings

  private setInput(id: string, v: string | number | boolean): void {
    const el = this.els[id] as HTMLInputElement;
    if (typeof v === 'boolean') el.checked = v;
    else el.value = String(v);
  }

  private applySettingsToInputs(): void {
    const s = this.settings;
    this.setInput('text', s.spec.text);
    this.setInput('tape', s.spec.tapeWidthMm);
    this.setInput('fontSize', s.spec.fontSizeDots);
    this.setInput('fontFamily', s.spec.fontFamily);
    if ((this.els.fontFamily as HTMLSelectElement).selectedIndex < 0) (this.els.fontFamily as HTMLSelectElement).selectedIndex = 0;
    this.setInput('bold', s.spec.bold);
    this.setInput('align', s.spec.align);
    this.setInput('lengthMode', s.spec.lengthMm === null ? 'auto' : 'fixed');
    this.setInput('lengthMm', s.spec.lengthMm ?? 30);
    this.setInput('marginMm', s.spec.marginMm);
    this.setInput('rotateText', s.spec.rotateText);
    this.setInput('invert', s.spec.invert);
    this.setInput('dither', s.spec.dither);
    this.setInput('flip180', s.flip180);
    this.setInput('copies', s.copies);
    this.setInput('darkness', s.darkness);
    if ((this.els.darkness as HTMLSelectElement).selectedIndex < 0) this.setInput('darkness', 15);
    this.setInput('cutType', s.cutType);
    this.setInput('clearance', s.clearance);
    this.setInput('zoom', s.zoom);
    this.setInput('headBytes', s.headBytes);
    this.setInput('maxRows', s.maxRows);
    this.setInput('position', s.position);
    this.setInput('swapHL', s.swapHL);
    this.setInput('acceptAll', s.acceptAll);
    this.setInput('chunkSize', s.chunkSize);
    this.setInput('writeMode', s.writeMode);
    this.setInput('testMode', s.testMode);
    this.els.modeBox.classList.toggle('live', !s.testMode);
  }

  private readInputs(): void {
    const v = (id: string) => (this.els[id] as HTMLInputElement).value;
    const c = (id: string) => (this.els[id] as HTMLInputElement).checked;
    const lengthMode = v('lengthMode');
    (this.els.lengthMm as HTMLInputElement).disabled = lengthMode !== 'fixed';
    this.spec = {
      text: v('text'),
      fontSizeDots: Math.max(8, Number(v('fontSize')) || 48),
      fontFamily: v('fontFamily'),
      bold: c('bold'),
      align: v('align') as Align,
      rotateText: c('rotateText'),
      tapeWidthMm: Number(v('tape')),
      lengthMm: lengthMode === 'fixed' ? Number(v('lengthMm')) || 30 : null,
      marginMm: Number(v('marginMm')) || 0,
      invert: c('invert'),
      dither: c('dither'),
    };
    this.settings = {
      ...this.settings,
      spec: { ...this.spec },
      copies: Math.max(1, Math.min(99, Number(v('copies')) || 1)),
      darkness: Math.max(1, Math.min(31, Number(v('darkness')) || 15)),
      cutType: Number(v('cutType')),
      clearance: Number(v('clearance')),
      flip180: c('flip180'),
      zoom: Number(v('zoom')) || 2,
      headBytes: Math.max(1, Number(v('headBytes')) || 12),
      maxRows: Math.max(1, Number(v('maxRows')) || 170),
      position: v('position') as Settings['position'],
      swapHL: c('swapHL'),
      acceptAll: c('acceptAll'),
      chunkSize: Math.max(1, Number(v('chunkSize')) || 20),
      writeMode: v('writeMode') as Settings['writeMode'],
    };
    this.transport.chunkSize = this.settings.chunkSize;
    if (!this.client.attributes.fromPrinter) this.client.attributes = this.assumedAttributes();
  }

  private persist(): void {
    saveSettings(this.settings);
  }

  // ------------------------------------------------------------------ rendering

  private updateAll(): void {
    try {
      this.rendered = renderLabel(this.spec);
    } catch (err) {
      this.log('error', `render failed: ${(err as Error).message}`);
      return;
    }
    const lc = this.els.labelCanvas as HTMLCanvasElement;
    monoToCanvas(this.rendered.mono, lc); // exactly the dots that will be printed
    this.els.labelMeta.textContent = `${this.rendered.lengthMm.toFixed(1)} × ${dotsToMm(this.rendered.heightDots).toFixed(1)} mm${this.rendered.truncated ? '  — text does not fit, make it smaller or the label longer' : ''}`;

    try {
      this.plan = this.client.plan(this.rendered.mono, {
        copies: this.settings.copies,
        darkness: this.settings.darkness,
        clearance: this.settings.clearance,
        cutType: this.settings.cutType,
        flip180: this.settings.flip180,
      });
      monoToCanvas(this.plan.raster.wireImage, this.els.wireCanvas as HTMLCanvasElement);
      const a = this.client.attributes;
      this.els.wireMeta.textContent = `${this.plan.raster.wireImage.width} × ${this.plan.raster.lengthDots} dots, ${this.plan.raster.bytesPerRow} B/row, ${this.plan.raster.bands.length} band(s) of ≤ ${a.maxPrintRows} rows, length field ${this.plan.raster.lengthDots}, ${this.plan.frames.length} frames, ${this.plan.totalBytes} B (${a.fromPrinter ? 'printer' : 'fallback'} attributes)`;
    } catch (err) {
      this.plan = null;
      this.els.wireMeta.textContent = `plan failed: ${(err as Error).message}`;
      this.log('error', `plan failed: ${(err as Error).message}`);
    }
    this.layoutPreviews();
    this.updateButtons();
  }

  /**
   * Sizes the preview canvases in CSS pixels. The label preview is scaled to fill the available
   * width (never below 1 dot = 1 px, so no dot is ever dropped; wider labels scroll sideways),
   * which is what makes it usable on a phone. The wire image keeps the explicit zoom setting.
   */
  private layoutPreviews(): void {
    const lc = this.els.labelCanvas as HTMLCanvasElement;
    if (lc.width > 0 && lc.height > 0) {
      const maxHeight = Math.min(240, Math.round(window.innerHeight * 0.3));
      // Whole-number scale only: every printer dot stays a crisp square block.
      const scale = Math.max(1, Math.floor(Math.min(8, this.availableWidth(lc) / lc.width, maxHeight / lc.height)));
      lc.style.width = `${Math.round(lc.width * scale)}px`;
      lc.style.height = `${Math.round(lc.height * scale)}px`;
    }
    const wc = this.els.wireCanvas as HTMLCanvasElement;
    if (wc.width > 0) {
      wc.style.width = `${wc.width * this.settings.zoom}px`;
      wc.style.height = `${wc.height * this.settings.zoom}px`;
    }
  }

  /** Inner width of a canvas' .preview-wrap, minus its padding. */
  private availableWidth(canvas: HTMLCanvasElement): number {
    const wrap = canvas.parentElement;
    if (!wrap) return 0;
    const style = getComputedStyle(wrap);
    return wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  }

  private get connected(): boolean {
    return this.transport.kind === 'ble' && this.transport.connected;
  }

  private updateButtons(): void {
    const connected = this.connected;
    const test = this.settings.testMode;
    const hasText = this.spec.text.trim().length > 0;
    (this.els.disconnectBtn as HTMLButtonElement).hidden = !connected;
    this.els.connectBtn.textContent = connected ? 'Change printer' : 'Connect printer';
    (this.els.connectBtn as HTMLButtonElement).disabled = this.connState === 'connecting' || this.connState === 'searching';
    (this.els.statusBtn as HTMLButtonElement).disabled = !connected;
    (this.els.firmwareBtn as HTMLButtonElement).disabled = !connected;
    (this.els.printBtn as HTMLButtonElement).disabled = this.printing || !this.plan || !hasText || (!test && !connected);
    (this.els.cancelBtn as HTMLButtonElement).hidden = !this.printing;
    (this.els.batchPrintBtn as HTMLButtonElement).disabled = this.printing || this.queue.length === 0 || (!test && !connected);
    this.els.printBtn.textContent = test ? 'Test print (nothing printed)' : !connected ? 'Connect a printer to print' : this.settings.copies > 1 ? `Print ${this.settings.copies} copies` : 'Print';
    this.els.batchPrintBtn.textContent = test ? 'Test queue' : 'Print queue';
    this.els.connStatus.textContent = this.connText;
    this.els.connStatus.className = `status ${this.connState}`;
  }

  private setTestMode(on: boolean): void {
    if (!on && !this.connected) {
      this.setMessage('warn', 'Connect the printer first to leave test mode.');
      (this.els.testMode as HTMLInputElement).checked = true;
      return;
    }
    this.settings.testMode = on;
    this.els.modeBox.classList.toggle('live', !on);
    this.persist();
    this.log(on ? 'info' : 'warn', on ? 'test mode on' : 'LIVE printing on');
    this.updateButtons();
  }

  private setMessage(level: 'info' | 'warn' | 'error', text: string): void {
    this.lastMessage = { level, text };
    const el = this.els.message;
    el.textContent = text;
    el.className = `message ${level}`;
    el.hidden = false;
    this.log(level, text);
  }

  private clearMessage(): void {
    this.els.message.hidden = true;
    this.lastMessage = null;
  }

  private setConn(state: ConnState, text: string): void {
    this.connState = state;
    this.connText = text;
    this.updateButtons();
  }

  private log(level: 'info' | 'tx' | 'rx' | 'warn' | 'error', msg: string): void {
    this.consoleUi.log(level, msg);
  }

  // ------------------------------------------------------------------ connection

  /** On page load: reconnect to the remembered printer without a chooser (needs getDevices support). */
  private async tryAutoReconnect(): Promise<void> {
    const remembered = loadDevice();
    if (!remembered) return;
    const bt = navigator.bluetooth!;
    if (!bt.getDevices) {
      this.setMessage('info', `Press "Connect printer" to reconnect to ${remembered.name}. (Automatic reconnect needs Chrome with persistent Bluetooth permissions.)`);
      return;
    }
    let device: BluetoothDevice | undefined;
    try {
      device = (await bt.getDevices()).find((d) => d.id === remembered.id);
    } catch (err) {
      this.log('warn', `getDevices failed: ${(err as Error).message}`);
    }
    if (!device) {
      this.setMessage('info', `Permission for ${remembered.name} is gone; press "Connect printer" to choose it again.`);
      return;
    }
    const dev = device;
    this.setConn('searching', `Looking for ${remembered.name}…`);
    try {
      if (dev.watchAdvertisements) {
        const ac = new AbortController();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            ac.abort();
            reject(new Error(`${remembered.name} not found. Is it switched on?`));
          }, 15000);
          dev.addEventListener(
            'advertisementreceived',
            () => {
              clearTimeout(timer);
              ac.abort();
              resolve();
            },
            { once: true },
          );
          dev.watchAdvertisements!({ signal: ac.signal }).catch((err: Error) => {
            clearTimeout(timer);
            if (err.name !== 'AbortError') reject(err);
          });
        });
      }
      await this.connectDevice(dev);
    } catch (err) {
      this.setConn('off', 'Not connected');
      this.setMessage('warn', (err as Error).message);
    }
  }

  private async connectInteractive(): Promise<void> {
    try {
      this.clearMessage();
      const device = await requestPrinterDevice({ acceptAllDevices: this.settings.acceptAll });
      this.log('info', `selected "${device.name ?? '(no name)'}"`);
      if (this.bleTransport) await this.disconnect(false);
      await this.connectDevice(device);
    } catch (err) {
      const msg = (err as Error).message;
      if (/cancelled|canceled|chooser/i.test(msg)) {
        this.updateButtons();
        return;
      }
      this.setConn('error', 'Not connected');
      this.setMessage('error', `Could not connect: ${msg}`);
    }
  }

  private async connectDevice(device: BluetoothDevice): Promise<void> {
    const name = device.name ?? 'printer';
    this.bleTransport?.dispose();
    const t = new WebBluetoothTransport(device, { chunkSize: this.settings.chunkSize, writeMode: this.settings.writeMode, log: (s) => this.log('info', s) });
    this.bleTransport = t;
    this.setConn('connecting', `Connecting to ${name}…`);
    try {
      await t.connect();
    } catch (err) {
      this.bleTransport = null;
      t.dispose();
      throw err;
    }
    this.transport = t;
    this.client = this.makeClient(t);
    saveDevice({ id: device.id, name });
    this.setConn('on', `Connected to ${name}`);
    const attrs = await this.client.queryAttributes();
    if (attrs.fromPrinter) {
      this.settings.headBytes = attrs.headWidthBytes;
      this.settings.maxRows = attrs.maxPrintRows;
      this.settings.position = attrs.printPosition;
      this.settings.swapHL = attrs.exchangeHL;
      this.setInput('headBytes', attrs.headWidthBytes);
      this.setInput('maxRows', attrs.maxPrintRows);
      this.setInput('position', attrs.printPosition);
      this.setInput('swapHL', attrs.exchangeHL);
      this.persist();
    }
    await this.client.queryFirmware();
    this.updatePrinterInfo();
    this.updateAll();
    if (!this.settings.testMode) this.log('warn', 'LIVE printing is on');
    this.clearMessage();
  }

  private async disconnect(switchToDry = true): Promise<void> {
    this.setHeartbeat(false);
    (this.els.heartbeatToggle as HTMLInputElement).checked = false;
    const t = this.bleTransport;
    this.bleTransport = null;
    if (t) {
      t.dispose();
      await t.disconnect();
    }
    if (switchToDry) this.switchToDryRunTransport();
    this.setConn('off', 'Not connected');
  }

  private switchToDryRunTransport(): void {
    this.transport = new DryRunTransport();
    this.transport.chunkSize = this.settings.chunkSize;
    this.client = this.makeClient(this.transport);
    this.updatePrinterInfo();
    this.updateAll();
  }

  private onDisconnected(reason: string): void {
    this.log('warn', `GATT disconnected (${reason})`);
    this.setHeartbeat(false);
    (this.els.heartbeatToggle as HTMLInputElement).checked = false;
    const t = this.bleTransport;
    this.switchToDryRunTransport();
    if (!t) return;
    const name = t.device.name ?? 'printer';
    this.setConn('searching', `Connection lost, reconnecting to ${name}…`);
    t.reconnect(5, 500)
      .then(async () => {
        this.transport = t;
        this.client = this.makeClient(t);
        this.setConn('on', `Connected to ${name}`);
        await this.client.queryAttributes();
        this.updatePrinterInfo();
        this.updateAll();
      })
      .catch((err: Error) => {
        this.setConn('off', 'Not connected');
        this.setMessage('warn', `Lost the printer and could not reconnect (${err.message}). Press "Connect printer".`);
      });
  }

  private onStatus(st: StatusFrame): void {
    if (this.connState === 'on' && st.batteryPercent !== null) {
      const name = this.bleTransport?.device.name ?? 'printer';
      this.connText = `Connected to ${name} · battery ${st.batteryPercent}%${st.charging ? ' ⚡' : ''}`;
      this.els.connStatus.textContent = this.connText;
    }
    if (st.statusCode !== 0 && st.statusCode !== 23) {
      this.setMessage('warn', `Printer: ${st.statusText}`);
    }
    this.updatePrinterInfo(st);
  }

  private setHeartbeat(on: boolean): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (on) {
      this.heartbeat = window.setInterval(() => {
        if (!this.printing && this.connected) void this.client.queryStatus();
      }, 1000);
    }
  }

  private updatePrinterInfo(st: StatusFrame | null = this.client.lastStatus): void {
    const rows: Array<[string, string]> = [];
    const remembered = loadDevice();
    if (remembered) rows.push(['remembered printer', remembered.name]);
    rows.push(['attributes', describeAttributes(this.client.attributes)]);
    if (this.client.firmware.length) rows.push(['firmware', this.client.firmware.join(' / ')]);
    if (st) {
      rows.push(['status', summarizeStatus(st)]);
      rows.push(['raw', toHex(st.raw)]);
    }
    const dl = this.els.printerInfo;
    dl.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
  }

  // ------------------------------------------------------------------ recent labels

  private renderRecent(): void {
    const box = this.els.recentList;
    box.innerHTML = '';
    (this.els.recentEmpty as HTMLElement).hidden = this.recent.length > 0;
    (this.els.recentPanel as HTMLElement).hidden = this.recent.length === 0;
    this.recent.forEach((r, i) => {
      const chip = document.createElement('span');
      chip.className = 'recent';
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = r.text.replace(/\n/g, ' ⏎ ');
      b.title = `${r.tapeWidthMm} mm tape, size ${r.fontSizeDots}${r.rotateText ? ', vertical' : ''}${r.lengthMm ? `, ${r.lengthMm} mm` : ''} · printed ${r.count}×`;
      b.addEventListener('click', () => {
        this.setInput('text', r.text);
        this.setInput('tape', r.tapeWidthMm);
        this.setInput('fontSize', r.fontSizeDots);
        this.setInput('rotateText', r.rotateText);
        this.setInput('bold', r.bold);
        this.setInput('lengthMode', r.lengthMm === null ? 'auto' : 'fixed');
        if (r.lengthMm !== null) this.setInput('lengthMm', r.lengthMm);
        this.readInputs();
        this.updateAll();
        this.persist();
      });
      const x = document.createElement('button');
      x.className = 'chip x';
      x.textContent = '×';
      x.title = 'remove from recent';
      x.addEventListener('click', () => {
        this.recent = removeRecent(i);
        this.renderRecent();
      });
      chip.append(b, x);
      box.append(chip);
    });
    if (this.recent.length > 0) {
      const clear = document.createElement('button');
      clear.className = 'chip muted';
      clear.textContent = 'clear all';
      clear.addEventListener('click', () => {
        clearRecent();
        this.recent = [];
        this.renderRecent();
      });
      box.append(clear);
    }
  }

  private rememberPrinted(spec: LabelSpec): void {
    if (!spec.text.trim()) return;
    this.recent = addRecent({
      text: spec.text,
      tapeWidthMm: spec.tapeWidthMm,
      fontSizeDots: spec.fontSizeDots,
      rotateText: spec.rotateText,
      lengthMm: spec.lengthMm,
      bold: spec.bold,
    });
    this.renderRecent();
  }

  // ------------------------------------------------------------------ printing

  private async printCurrent(): Promise<void> {
    if (!this.plan || !this.rendered) return;
    const spec = { ...this.spec };
    const res = await this.printJob();
    if (res === 'done' && !this.settings.testMode) this.rememberPrinted(spec);
  }

  /**
   * Prints the current label. The E1 only cuts at the end of a job regardless of the cut-type
   * bits (hardware-observed), so "cut after every copy" is implemented as one single-copy job per
   * copy; "once at the end" sends all copies in one job.
   */
  private async printJob(): Promise<'done' | 'cancelled' | 'error'> {
    if (!this.plan || !this.rendered) return 'error';
    const copies = this.settings.copies;
    if (this.settings.cutType !== CUT_TYPE.SINGLE || copies <= 1) return this.runPrint(this.plan);
    for (let i = 1; i <= copies; i++) {
      const single = this.client.plan(this.rendered.mono, {
        copies: 1,
        darkness: this.settings.darkness,
        clearance: this.settings.clearance,
        cutType: this.settings.cutType,
        flip180: this.settings.flip180,
      });
      this.log('info', `copy ${i}/${copies} as a separate job (cut after each copy)`);
      const res = await this.runPrint(single);
      if (res !== 'done') return res;
      if (this.cancelRequested) return 'cancelled';
    }
    return 'done';
  }

  private async runPrint(plan: PrintPlan): Promise<'done' | 'cancelled' | 'error'> {
    if (this.printing) return 'error';
    this.printing = true;
    this.clearMessage();
    this.updateButtons();
    (this.els.progressBar as HTMLElement).style.width = '0%';
    try {
      let result: 'done' | 'cancelled' | 'error';
      if (this.settings.testMode && this.transport.kind !== 'dryrun') {
        const dry = new DryRunTransport();
        dry.chunkSize = this.settings.chunkSize;
        const c = this.makeClient(dry);
        c.attributes = this.client.attributes;
        result = await c.print(plan, this.progressCb());
      } else {
        result = await this.client.print(plan, this.progressCb());
      }
      if (result === 'error') this.setMessage('error', this.lastMessage?.level === 'warn' ? this.lastMessage.text : 'Printing failed. Details are in the console under Advanced.');
      else if (result === 'cancelled') this.setMessage('info', 'Printing cancelled.');
      else if (this.settings.testMode) this.setMessage('info', 'Test mode: frames were logged under Advanced, nothing was printed.');
      return result;
    } catch (err) {
      this.setMessage('error', `Printing failed: ${(err as Error).message}`);
      return 'error';
    } finally {
      this.printing = false;
      this.updateButtons();
    }
  }

  private progressCb() {
    const total = this.plan?.frames.filter((f) => f.kind === 'band').length ?? 1;
    let sent = 0;
    return {
      onProgress: () => {
        sent++;
        (this.els.progressBar as HTMLElement).style.width = `${Math.min(100, Math.round((sent / total) * 100))}%`;
      },
      shouldCancel: () => this.cancelRequested,
    };
  }

  private dumpPlan(): void {
    if (!this.plan) return;
    (this.els.advanced as HTMLDetailsElement).open = true;
    const verify = (this.els.verifyLzo as HTMLInputElement).checked;
    this.log('info', `--- frame plan: ${this.plan.frames.length} frames, ${this.plan.totalBytes} bytes, chunk ${this.settings.chunkSize} B ---`);
    this.plan.frames.forEach((f, i) => {
      this.log('tx', `#${i + 1} [${f.kind}] ${f.note} (${f.bytes.length} B): ${toHex(f.bytes)}`);
    });
    if (verify) {
      this.plan.raster.bands.forEach((b, i) => {
        try {
          const d = lzo1xDecompress(b.compressed, b.raw.length);
          let ok = d.length === b.raw.length;
          for (let j = 0; ok && j < d.length; j++) if (d[j] !== b.raw[j]) ok = false;
          this.log(ok ? 'info' : 'error', `band ${i + 1}: LZO round-trip ${ok ? 'OK' : 'MISMATCH'} (${b.raw.length} -> ${b.compressed.length} B)`);
        } catch (err) {
          this.log('error', `band ${i + 1}: LZO decode failed: ${(err as Error).message}`);
        }
      });
    }
  }

  // ------------------------------------------------------------------ batch

  private loadBatch(): void {
    const lines = (this.els.batchText as HTMLTextAreaElement).value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    this.queue.push(...lines.map((text) => ({ text, state: 'pending' as const })));
    (this.els.batchText as HTMLTextAreaElement).value = '';
    this.renderQueue();
  }

  private renderQueue(): void {
    const ul = this.els.queueList;
    ul.innerHTML = '';
    this.queue.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = item.state;
      const span = document.createElement('span');
      span.textContent = `${item.text}${item.state === 'pending' ? '' : `  · ${item.state}`}`;
      const rm = document.createElement('button');
      rm.className = 'chip x';
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        this.queue.splice(i, 1);
        this.renderQueue();
      });
      li.append(span, rm);
      ul.append(li);
    });
    this.updateButtons();
  }

  private async printQueue(): Promise<void> {
    const items = this.queue.filter((q) => q.state === 'pending' || q.state === 'failed');
    for (const item of items) {
      if (this.cancelRequested) break;
      item.state = 'active';
      this.renderQueue();
      this.setInput('text', item.text);
      this.readInputs();
      this.updateAll();
      if (!this.plan) {
        item.state = 'failed';
        continue;
      }
      const spec = { ...this.spec };
      const res = await this.printJob();
      item.state = res === 'done' ? 'done' : 'failed';
      if (res === 'done' && !this.settings.testMode) this.rememberPrinted(spec);
      this.renderQueue();
      if (res !== 'done') break;
    }
    this.cancelRequested = false;
    this.queue = this.queue.filter((q) => q.state !== 'done');
    this.renderQueue();
    this.persist();
  }
}
