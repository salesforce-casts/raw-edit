/**
 * Incremental SHA-256 (FIPS 180-4).
 *
 * WebCrypto has no streaming digest API, so a multi-gigabyte upload cannot be hashed
 * with `crypto.subtle.digest` without holding the whole file in memory. This runs in a
 * Web Worker on the client and in Node on the worker, so both ends compute the same
 * digest over the same bytes and we can prove the stored object matches what was
 * picked on the phone.
 *
 * Verified against the NIST test vectors in test/hash/sha256.test.ts.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

export class Sha256Stream {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalLength = 0;
  private readonly w = new Uint32Array(64);
  private finished = false;

  update(chunk: Uint8Array): this {
    if (this.finished) throw new Error('Sha256Stream: update() after digest()');
    this.totalLength += chunk.length;

    let offset = 0;
    if (this.bufferLength > 0) {
      const needed = Math.min(64 - this.bufferLength, chunk.length);
      this.buffer.set(chunk.subarray(0, needed), this.bufferLength);
      this.bufferLength += needed;
      offset = needed;
      if (this.bufferLength === 64) {
        this.compress(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= chunk.length) {
      this.compress(chunk, offset);
      offset += 64;
    }

    if (offset < chunk.length) {
      this.buffer.set(chunk.subarray(offset), 0);
      this.bufferLength = chunk.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error('Sha256Stream: digest() called twice');
    this.finished = true;

    const bitLength = this.totalLength * 8;
    const padded = new Uint8Array(this.bufferLength < 56 ? 64 : 128);
    padded.set(this.buffer.subarray(0, this.bufferLength), 0);
    padded[this.bufferLength] = 0x80;

    // 64-bit big-endian length. Split so files above 2^32 bits (512 MB) are correct.
    const view = new DataView(padded.buffer);
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    view.setUint32(padded.length - 8, high, false);
    view.setUint32(padded.length - 4, low, false);

    for (let offset = 0; offset < padded.length; offset += 64) this.compress(padded, offset);

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, this.state[i]!, false);
    return out;
  }

  hex(): string {
    return bytesToHex(this.digest());
  }

  /**
   * One 64-byte block. Written with plain locals and inlined rotations rather than
   * helper calls or destructuring: this runs ~16 million times on a 1 GB upload, and
   * on a phone the difference between the tidy version and this one is minutes.
   */
  private compress(block: Uint8Array, offset: number): void {
    const w = this.w;
    const state = this.state;

    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = ((block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Sha256Stream().update(bytes).hex();
}

/**
 * Stable fingerprint used to match a re-selected file to an interrupted upload after
 * a Safari refresh. Not a security control — an integrity hint for resume matching.
 */
export function fileFingerprint(name: string, size: number, lastModified: number): string {
  return sha256Hex(`${name}:${size}:${lastModified}`);
}
