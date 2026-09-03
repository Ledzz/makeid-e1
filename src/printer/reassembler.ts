/**
 * Reassembles notification chunks into one response frame.
 * CONFIRMED behaviour (BluetoothConnect_BLE.onCharacteristicChanged, 2.2.0):
 *   - a chunk longer than 4 bytes starting with "##" (0x23 0x23) has its first 4 bytes stripped
 *   - chunks are concatenated; nothing is decided before 3 bytes are available
 *   - if the buffer starts with "**" the buffer is the complete response
 *   - otherwise the expected total length is buffer[1] (the SDK reads buffer[1] | buffer[2] << 8
 *     for the ABF0 service, then masks with 0xFF, so byte 1 alone decides)
 * No DOM access.
 */
import { concatBytes } from './hex.ts';

export type ServiceFlavour = 'new' | 'old';

export class ResponseReassembler {
  private chunks: Uint8Array[] = [];
  private total = 0;

  flavour: ServiceFlavour;

  constructor(flavour: ServiceFlavour = 'new') {
    this.flavour = flavour;
  }

  reset(): void {
    this.chunks = [];
    this.total = 0;
  }

  get pendingBytes(): number {
    return this.total;
  }

  /**
   * Feeds one notification. Returns the complete response when available, else null.
   * Any bytes beyond the declared length are discarded, like the SDK does.
   */
  push(chunk: Uint8Array): Uint8Array | null {
    let value = chunk;
    if (value.length > 4 && value[0] === 0x23 && value[1] === 0x23) {
      value = value.subarray(4);
    }
    if (value.length === 0) return null;
    this.chunks.push(value);
    this.total += value.length;
    if (this.total < 3) return null;
    const buf = concatBytes(...this.chunks);
    if (buf[0] === 0x2a && buf[1] === 0x2a) {
      this.reset();
      return buf;
    }
    let expected: number;
    if (this.flavour === 'old') {
      expected = buf[1];
    } else {
      expected = ((buf[2] << 8) | buf[1]) & 0xff;
    }
    if (expected === 0) {
      // The SDK would allocate a zero-length buffer and never complete; treat as garbage.
      this.reset();
      return buf;
    }
    if (buf.length >= expected) {
      this.reset();
      return buf.subarray(0, expected);
    }
    return null;
  }
}
