/**
 * Web Bluetooth transport for the wewin BLE UART services.
 * Uses only navigator.bluetooth (no DOM). requestDevice() must be called from a user gesture
 * on an HTTPS or localhost page.
 *
 * UUIDs CONFIRMED from BluetoothConnect_BLE.java (2.2.0):
 *   new printer: service ABF0, write ABF1, notify ABF2
 *   old printer: service 49535343-FE7D-..., write ...8841..., notify ...1E4D...
 */
import type { Transport, Unsubscribe } from './transport.ts';
import type { ServiceFlavour } from './reassembler.ts';

export const UUID_NEW_SERVICE = '0000abf0-0000-1000-8000-00805f9b34fb';
export const UUID_NEW_WRITE = '0000abf1-0000-1000-8000-00805f9b34fb';
export const UUID_NEW_NOTIFY = '0000abf2-0000-1000-8000-00805f9b34fb';
export const UUID_OLD_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
export const UUID_OLD_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';
export const UUID_OLD_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
/** OTA service (firmware update only, never used for printing) */
export const UUID_OTA_SERVICE = '1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0';

export const OPTIONAL_SERVICES = [UUID_NEW_SERVICE, UUID_OLD_SERVICE, UUID_OTA_SERVICE];

/** Name prefixes the MakeID-Life app accepts for the E1 theme (StaticArgs.KEY / KEY_AUTO). */
export const E1_NAME_PREFIXES = ['E1', 'e1'];

export interface RequestOptions {
  /** Show every BLE device instead of filtering by name prefix. */
  acceptAllDevices?: boolean;
  namePrefixes?: string[];
}

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

/** Wraps requestDevice(); throws when Web Bluetooth is not available. */
export async function requestPrinterDevice(opts: RequestOptions = {}): Promise<BluetoothDevice> {
  if (!isWebBluetoothAvailable()) {
    throw new Error('Web Bluetooth is not available in this browser (needs Chrome/Edge on HTTPS or localhost).');
  }
  const prefixes = opts.namePrefixes ?? E1_NAME_PREFIXES;
  const request: RequestDeviceOptions = opts.acceptAllDevices
    ? { acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES }
    : { filters: prefixes.map((p) => ({ namePrefix: p })), optionalServices: OPTIONAL_SERVICES };
  return navigator.bluetooth!.requestDevice(request);
}

export interface GattEndpoints {
  flavour: ServiceFlavour;
  serviceUuid: string;
  write: BluetoothRemoteGATTCharacteristic;
  notify: BluetoothRemoteGATTCharacteristic;
  writeWithResponse: boolean;
}

export interface WebBluetoothTransportOptions {
  chunkSize?: number;
  /** Force with/without response; default = characteristic default (with response when WRITE is present). */
  writeMode?: 'auto' | 'with-response' | 'without-response';
  log?: (line: string) => void;
}

/**
 * Locates the UART service/characteristics the SDK would pick
 * (BluetoothConnect_BLE.setBluetoothGattCharacteristic + fallbacks).
 */
export async function discoverEndpoints(server: BluetoothRemoteGATTServer, log: (s: string) => void = () => {}): Promise<GattEndpoints> {
  const tryService = async (svcUuid: string, writeUuid: string, notifyUuid: string, flavour: ServiceFlavour) => {
    try {
      const svc = await server.getPrimaryService(svcUuid);
      const write = await svc.getCharacteristic(writeUuid);
      const notify = await svc.getCharacteristic(notifyUuid);
      return { svc, write, notify, flavour };
    } catch {
      return null;
    }
  };
  let found = await tryService(UUID_NEW_SERVICE, UUID_NEW_WRITE, UUID_NEW_NOTIFY, 'new');
  if (!found) found = await tryService(UUID_OLD_SERVICE, UUID_OLD_WRITE, UUID_OLD_NOTIFY, 'old');
  if (!found) {
    // SDK fallback: any service with a writable and a notify/indicate characteristic
    log('known UART services not found, scanning all primary services');
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      const write = chars.find((c) => c.properties.writeWithoutResponse) ?? chars.find((c) => c.properties.write);
      const notify = chars.find((c) => c.properties.notify || c.properties.indicate);
      log(`service ${svc.uuid}: ${chars.map((c) => `${c.uuid.slice(4, 8)}[${propsString(c)}]`).join(' ')}`);
      if (write && notify) {
        found = { svc, write, notify, flavour: 'new' };
        break;
      }
    }
  }
  if (!found) throw new Error('No UART-style service found on this device.');
  log(`using service ${found.svc.uuid} (flavour ${found.flavour}); write ${found.write.uuid} [${propsString(found.write)}], notify ${found.notify.uuid} [${propsString(found.notify)}]`);
  return {
    flavour: found.flavour,
    serviceUuid: found.svc.uuid,
    write: found.write,
    notify: found.notify,
    writeWithResponse: found.write.properties.write,
  };
}

function propsString(c: BluetoothRemoteGATTCharacteristic): string {
  const p = c.properties;
  const out: string[] = [];
  if (p.read) out.push('R');
  if (p.write) out.push('W');
  if (p.writeWithoutResponse) out.push('WNR');
  if (p.notify) out.push('N');
  if (p.indicate) out.push('I');
  return out.join(',');
}

export class WebBluetoothTransport implements Transport {
  readonly kind = 'ble' as const;
  chunkSize: number;
  private endpoints: GattEndpoints | null = null;
  private notifyHandlers = new Set<(data: Uint8Array) => void>();
  private disconnectHandlers = new Set<(reason: string) => void>();
  private readonly log: (line: string) => void;
  private writeMode: 'auto' | 'with-response' | 'without-response';
  private onValueChanged = (ev: Event) => {
    const target = ev.target as BluetoothRemoteGATTCharacteristic;
    const dv = target.value;
    if (!dv) return;
    const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    for (const h of this.notifyHandlers) h(bytes);
  };
  private onGattDisconnected = () => {
    this.endpoints = null;
    for (const h of this.disconnectHandlers) h('gattserverdisconnected');
  };

  readonly device: BluetoothDevice;

  constructor(device: BluetoothDevice, opts: WebBluetoothTransportOptions = {}) {
    this.device = device;
    this.chunkSize = opts.chunkSize ?? 20;
    this.writeMode = opts.writeMode ?? 'auto';
    this.log = opts.log ?? (() => {});
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
  }

  get connected(): boolean {
    return !!this.device.gatt?.connected && this.endpoints !== null;
  }

  get flavour(): ServiceFlavour {
    return this.endpoints?.flavour ?? 'new';
  }

  get endpointInfo(): GattEndpoints | null {
    return this.endpoints;
  }

  /** Connects (or reconnects) GATT, discovers the UART endpoints and starts notifications. */
  async connect(): Promise<void> {
    const gatt = this.device.gatt;
    if (!gatt) throw new Error('device has no GATT server');
    if (!gatt.connected) {
      this.log('connecting GATT');
      await gatt.connect();
    }
    this.log('discovering services');
    const ep = await discoverEndpoints(gatt, this.log);
    ep.notify.addEventListener('characteristicvaluechanged', this.onValueChanged);
    await ep.notify.startNotifications();
    this.log('notifications enabled');
    this.endpoints = ep;
  }

  /**
   * Reconnect with exponential backoff. Web Bluetooth allows gatt.connect() on a previously
   * granted device without a new user gesture.
   */
  async reconnect(attempts = 5, baseDelayMs = 500): Promise<void> {
    let lastErr: unknown = null;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.connect();
        return;
      } catch (err) {
        lastErr = err;
        const delay = baseDelayMs * 2 ** i;
        this.log(`reconnect attempt ${i + 1}/${attempts} failed: ${(err as Error).message}; retrying in ${delay} ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('reconnect failed');
  }

  async write(chunk: Uint8Array): Promise<void> {
    const ep = this.endpoints;
    if (!ep) throw new Error('not connected');
    const mode = this.writeMode === 'auto' ? (ep.writeWithResponse ? 'with-response' : 'without-response') : this.writeMode;
    // Copy into a fresh ArrayBuffer so subarray views never leak their parent buffer.
    const buf = chunk.slice().buffer;
    if (mode === 'with-response') {
      await ep.write.writeValueWithResponse(buf);
    } else {
      await ep.write.writeValueWithoutResponse(buf);
    }
  }

  onNotify(handler: (data: Uint8Array) => void): Unsubscribe {
    this.notifyHandlers.add(handler);
    return () => this.notifyHandlers.delete(handler);
  }

  onDisconnect(handler: (reason: string) => void): Unsubscribe {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  async disconnect(): Promise<void> {
    const ep = this.endpoints;
    if (ep) {
      try {
        ep.notify.removeEventListener('characteristicvaluechanged', this.onValueChanged);
        await ep.notify.stopNotifications();
      } catch {
        /* ignore */
      }
    }
    this.endpoints = null;
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
  }

  dispose(): void {
    this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
  }
}
