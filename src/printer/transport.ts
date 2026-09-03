/**
 * Transport abstraction between the protocol client and the byte pipe (Web Bluetooth or dry run).
 * No DOM access.
 */

export type Unsubscribe = () => void;

export interface Transport {
  readonly kind: 'ble' | 'dryrun';
  /** Largest payload per write; the client chunks frames to this size. */
  chunkSize: number;
  readonly connected: boolean;
  /** Writes one chunk and resolves when the local stack has accepted/acked it (backpressure). */
  write(chunk: Uint8Array): Promise<void>;
  onNotify(handler: (data: Uint8Array) => void): Unsubscribe;
  onDisconnect(handler: (reason: string) => void): Unsubscribe;
  disconnect(): Promise<void>;
}

/**
 * Dry-run transport: records every chunk, never produces notifications.
 * The client detects `kind === 'dryrun'` and does not wait for responses.
 */
export class DryRunTransport implements Transport {
  readonly kind = 'dryrun' as const;
  chunkSize = 20;
  connected = true;
  readonly written: Uint8Array[] = [];
  private notifyHandlers = new Set<(data: Uint8Array) => void>();

  async write(chunk: Uint8Array): Promise<void> {
    this.written.push(chunk.slice());
  }

  onNotify(handler: (data: Uint8Array) => void): Unsubscribe {
    this.notifyHandlers.add(handler);
    return () => this.notifyHandlers.delete(handler);
  }

  onDisconnect(): Unsubscribe {
    return () => {};
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** Test hook: inject a fake notification (used only by unit tests). */
  injectNotification(data: Uint8Array): void {
    for (const h of this.notifyHandlers) h(data);
  }
}

/** Splits a frame into transport-sized chunks. */
export function chunkFrame(frame: Uint8Array, chunkSize: number): Uint8Array[] {
  const size = Math.max(1, chunkSize | 0);
  const out: Uint8Array[] = [];
  for (let i = 0; i < frame.length; i += size) out.push(frame.subarray(i, Math.min(frame.length, i + size)));
  return out;
}
