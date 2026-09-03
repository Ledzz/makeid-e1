/**
 * LZO1X-1 compressor and LZO1X decompressor, ported from minilzo (as shipped inside the
 * MakeID-Life APK as org.minilzo.common.MiniLZO). The printer expects the raw LZO1X stream
 * that minilzo's lzo1x_1_compress emits: no header, no length prefix, terminated by the
 * standard end-of-stream marker 11 00 00. CONFIRMED (LZOUtil.lzo1xCompress, CreateNewProtocolArray).
 *
 * The exact bytes may differ from the Java SDK for the same input (hash/match choice), but any
 * conforming LZO1X stream decompresses identically on the printer.
 *
 * Zero dependencies. No DOM access.
 */

const M2_MAX_LEN = 8;
const M3_MAX_LEN = 33;
const M4_MAX_LEN = 9;
const M2_MAX_OFFSET = 0x0800;
const M3_MAX_OFFSET = 0x4000;
const M4_MAX_OFFSET = 0xbfff;
const M3_MARKER = 32;
const M4_MARKER = 16;
const D_BITS = 14;
const D_MASK = (1 << D_BITS) - 1;
const D_HIGH = (D_MASK >> 1) + 1;

/** Upper bound of compressed size for `n` input bytes (minilzo rule of thumb, as used by LZOUtil). */
export function lzo1xCompressBound(n: number): number {
  return n + (n >> 4) + 64 + 3;
}

function dindex1(src: Uint8Array, ip: number): number {
  // DX3(p,5,5,6): ((((p[3] << 6) ^ p[2]) << 5) ^ p[1]) << 5 ^ p[0]
  const v = (((((src[ip + 3] << 6) ^ src[ip + 2]) << 5) ^ src[ip + 1]) << 5) ^ src[ip];
  return (Math.imul(v, 0x21) >> 5) & D_MASK;
}

function dindex2(d: number): number {
  return (d & (D_MASK & 0x7ff)) ^ (D_HIGH | 0x1f);
}

/**
 * Core of lzo1x_1_compress. Returns the number of trailing input bytes that were not encoded
 * (the caller emits them as the final literal run). `out` must have room for compressBound bytes.
 */
function doCompress(src: Uint8Array, srcLen: number, out: Uint8Array, outLen: { v: number }, dict: Int32Array): number {
  let ip = 0;
  let op = 0;
  let ii = 0; // start of the pending literal run
  const inEnd = srcLen;
  const ipEnd = srcLen - M2_MAX_LEN - 5;

  ip += 4;
  for (;;) {
    let mPos: number;
    let mOff: number;
    let mLen: number;
    let dIndex: number;

    // find a match
    for (;;) {
      dIndex = dindex1(src, ip);
      mPos = dict[dIndex];
      let ok = false;
      if (mPos >= 0) {
        mOff = ip - mPos;
        if (mOff > 0 && mOff <= M4_MAX_OFFSET) {
          if (mOff <= M2_MAX_OFFSET || src[mPos + 3] === src[ip + 3]) {
            ok = true;
          } else {
            dIndex = dindex2(dIndex);
            mPos = dict[dIndex];
            if (mPos >= 0) {
              mOff = ip - mPos;
              if (mOff > 0 && mOff <= M4_MAX_OFFSET && (mOff <= M2_MAX_OFFSET || src[mPos + 3] === src[ip + 3])) {
                ok = true;
              }
            }
          }
        }
      }
      if (ok && src[mPos] === src[ip] && src[mPos + 1] === src[ip + 1] && src[mPos + 2] === src[ip + 2]) {
        break; // match found
      }
      // literal
      dict[dIndex] = ip;
      ip++;
      if (ip >= ipEnd) {
        outLen.v = op;
        return inEnd - ii;
      }
    }

    // emit pending literals
    dict[dIndex] = ip;
    let t = ip - ii;
    if (t > 0) {
      if (op === 0 && t <= 238) {
        out[op++] = 17 + t;
      } else if (t <= 3) {
        out[op - 2] |= t;
      } else if (t <= 18) {
        out[op++] = t - 3;
      } else {
        let tt = t - 18;
        out[op++] = 0;
        while (tt > 255) {
          tt -= 255;
          out[op++] = 0;
        }
        out[op++] = tt;
      }
      do {
        out[op++] = src[ii++];
      } while (--t > 0);
    }

    // determine match length
    mOff = ip - mPos!;
    ip += 3;
    if (
      src[mPos! + 3] !== src[ip++] ||
      src[mPos! + 4] !== src[ip++] ||
      src[mPos! + 5] !== src[ip++] ||
      src[mPos! + 6] !== src[ip++] ||
      src[mPos! + 7] !== src[ip++] ||
      src[mPos! + 8] !== src[ip++]
    ) {
      // short match (3..8 bytes): ip now points one past the first mismatch
      ip--;
      mLen = ip - ii;
      if (mOff <= M2_MAX_OFFSET) {
        mOff -= 1;
        out[op++] = ((mLen - 1) << 5) | ((mOff & 7) << 2);
        out[op++] = mOff >> 3;
      } else if (mOff <= M3_MAX_OFFSET) {
        mOff -= 1;
        out[op++] = M3_MARKER | (mLen - 2);
        out[op++] = (mOff & 63) << 2;
        out[op++] = mOff >> 6;
      } else {
        mOff -= 0x4000;
        out[op++] = M4_MARKER | ((mOff & 0x4000) >> 11) | (mLen - 2);
        out[op++] = (mOff & 63) << 2;
        out[op++] = mOff >> 6;
      }
    } else {
      // long match: extend while bytes keep matching
      let m = mPos! + M2_MAX_LEN + 1;
      while (ip < inEnd && src[m] === src[ip]) {
        m++;
        ip++;
      }
      mLen = ip - ii;
      if (mOff <= M3_MAX_OFFSET) {
        mOff -= 1;
        if (mLen <= M3_MAX_LEN) {
          out[op++] = M3_MARKER | (mLen - 2);
        } else {
          mLen -= M3_MAX_LEN;
          out[op++] = M3_MARKER;
          while (mLen > 255) {
            mLen -= 255;
            out[op++] = 0;
          }
          out[op++] = mLen;
        }
      } else {
        mOff -= 0x4000;
        if (mLen <= M4_MAX_LEN) {
          out[op++] = M4_MARKER | ((mOff & 0x4000) >> 11) | (mLen - 2);
        } else {
          mLen -= M4_MAX_LEN;
          out[op++] = M4_MARKER | ((mOff & 0x4000) >> 11);
          while (mLen > 255) {
            mLen -= 255;
            out[op++] = 0;
          }
          out[op++] = mLen;
        }
      }
      out[op++] = (mOff & 63) << 2;
      out[op++] = mOff >> 6;
    }

    ii = ip;
    if (ip >= ipEnd) {
      outLen.v = op;
      return inEnd - ii;
    }
  }
}

/** lzo1x_1_compress: returns the raw LZO1X-1 stream for `src`. */
export function lzo1xCompress(src: Uint8Array): Uint8Array {
  const srcLen = src.length;
  const out = new Uint8Array(lzo1xCompressBound(srcLen));
  const outLen = { v: 0 };
  let t: number;
  let op: number;
  if (srcLen <= M2_MAX_LEN + 5) {
    t = srcLen;
    op = 0;
  } else {
    const dict = new Int32Array(1 << D_BITS).fill(-1);
    t = doCompress(src, srcLen, out, outLen, dict);
    op = outLen.v;
  }
  if (t > 0) {
    let ii = srcLen - t;
    if (op === 0 && t <= 238) {
      out[op++] = 17 + t;
    } else if (t <= 3) {
      out[op - 2] |= t;
    } else if (t <= 18) {
      out[op++] = t - 3;
    } else {
      let tt = t - 18;
      out[op++] = 0;
      while (tt > 255) {
        tt -= 255;
        out[op++] = 0;
      }
      out[op++] = tt;
    }
    do {
      out[op++] = src[ii++];
    } while (--t > 0);
  }
  // end-of-stream marker
  out[op++] = M4_MARKER | 1;
  out[op++] = 0;
  out[op++] = 0;
  return out.slice(0, op);
}

/**
 * lzo1x_decompress_safe equivalent (bounds-checked). Used by the unit tests to round-trip the
 * compressor output; exported so the dry-run console can verify bands.
 */
export function lzo1xDecompress(src: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let ip = 0;
  let op = 0;
  const inEnd = src.length;
  const fail = (msg: string): never => {
    throw new Error(`lzo1x decompress: ${msg} (ip=${ip}, op=${op})`);
  };
  const needIn = (n: number) => {
    if (ip + n > inEnd) fail('input overrun');
  };
  const needOut = (n: number) => {
    if (op + n > out.length) fail('output overrun');
  };
  const copyMatch = (mPos: number, len: number) => {
    if (mPos < 0) fail('lookbehind overrun');
    needOut(len);
    for (let i = 0; i < len; i++) out[op++] = out[mPos++];
  };

  let t: number;
  let state: 'top' | 'first_literal_run' | 'match' | 'match_next' = 'top';

  needIn(1);
  if (src[ip] > 17) {
    t = src[ip++] - 17;
    if (t < 4) {
      state = 'match_next';
    } else {
      needIn(t);
      needOut(t);
      for (let i = 0; i < t; i++) out[op++] = src[ip++];
      state = 'first_literal_run';
    }
  }

  for (;;) {
    if (state === 'top') {
      needIn(1);
      t = src[ip++];
      if (t >= 16) {
        state = 'match';
      } else {
        if (t === 0) {
          while (true) {
            needIn(1);
            if (src[ip] !== 0) break;
            t += 255;
            ip++;
          }
          t += 15 + src[ip++];
        }
        t += 3;
        needIn(t);
        needOut(t);
        for (let i = 0; i < t; i++) out[op++] = src[ip++];
        state = 'first_literal_run';
      }
      continue;
    }
    if (state === 'first_literal_run') {
      needIn(1);
      t = src[ip++];
      if (t >= 16) {
        state = 'match';
        continue;
      }
      // M1 match after a literal run
      needIn(1);
      const mPos = op - (1 + M2_MAX_OFFSET) - (t >> 2) - (src[ip++] << 2);
      copyMatch(mPos, 3);
      // match_done
      t = src[ip - 2] & 3;
      if (t === 0) {
        state = 'top';
      } else {
        state = 'match_next';
      }
      continue;
    }
    if (state === 'match') {
      let mPos: number;
      if (t! >= 64) {
        needIn(1);
        mPos = op - 1 - ((t! >> 2) & 7) - (src[ip++] << 3);
        t = (t! >> 5) - 1;
        copyMatch(mPos, t + 2);
      } else if (t! >= 32) {
        t = t! & 31;
        if (t === 0) {
          while (true) {
            needIn(1);
            if (src[ip] !== 0) break;
            t += 255;
            ip++;
          }
          t += 31 + src[ip++];
        }
        needIn(2);
        mPos = op - 1 - ((src[ip] >> 2) + (src[ip + 1] << 6));
        ip += 2;
        copyMatch(mPos, t + 2);
      } else if (t! >= 16) {
        mPos = op - ((t! & 8) << 11);
        t = t! & 7;
        if (t === 0) {
          while (true) {
            needIn(1);
            if (src[ip] !== 0) break;
            t += 255;
            ip++;
          }
          t += 7 + src[ip++];
        }
        needIn(2);
        mPos -= (src[ip] >> 2) + (src[ip + 1] << 6);
        ip += 2;
        if (mPos === op) {
          // end of stream
          if (op !== out.length) fail(`length mismatch: got ${op}, expected ${out.length}`);
          return out;
        }
        mPos -= 0x4000;
        copyMatch(mPos, t + 2);
      } else {
        needIn(1);
        mPos = op - 1 - (t! >> 2) - (src[ip++] << 2);
        copyMatch(mPos, 2);
      }
      // match_done
      t = src[ip - 2] & 3;
      if (t === 0) {
        state = 'top';
      } else {
        state = 'match_next';
      }
      continue;
    }
    // match_next: copy 1..3 literals then the next opcode must be a match
    needIn(t!);
    needOut(t!);
    for (let i = 0; i < t!; i++) out[op++] = src[ip++];
    needIn(1);
    t = src[ip++];
    state = 'match';
  }
}
