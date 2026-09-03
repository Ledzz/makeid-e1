/**
 * wewin frame checksum.
 *
 * CONFIRMED: com.wewin.wewinprinter_api.wewinPrinterOperateHelper.getCheckNum
 *
 *   byte b = 0;
 *   for (int i = 0; i < bArr.length - 1; i++) b = (byte)(b - (bArr[i] & 0xFF));
 *   return b;
 *
 * i.e. the checksum is the two's complement of the sum of all preceding bytes, so the
 * sum of the complete frame is 0 mod 256.
 */

/** Computes the checksum over `frame[0 .. frame.length - 2]` (the last byte is the slot). */
export function wewinChecksum(frame: ArrayLike<number>): number {
  let b = 0;
  for (let i = 0; i < frame.length - 1; i++) {
    b = (b - (frame[i] & 0xff)) & 0xff;
  }
  return b;
}

/** Computes the checksum for a payload that does not yet include the checksum slot. */
export function checksumOf(bytesWithoutChecksum: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < bytesWithoutChecksum.length; i++) {
    sum = (sum + (bytesWithoutChecksum[i] & 0xff)) & 0xff;
  }
  return (256 - sum) & 0xff;
}

/** True when the whole frame sums to 0 mod 256 (valid wewin checksum). */
export function verifyChecksum(frame: ArrayLike<number>): boolean {
  if (frame.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum = (sum + (frame[i] & 0xff)) & 0xff;
  return sum === 0;
}
