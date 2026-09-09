import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256Stream, fileFingerprint, sha256Hex } from '../src/hash/sha256.js';

describe('Sha256Stream', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('agrees with node:crypto on random data', () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000, 100_000]) {
      const data = randomBytes(size);
      const expected = createHash('sha256').update(data).digest('hex');
      expect(new Sha256Stream().update(new Uint8Array(data)).hex()).toBe(expected);
    }
  });

  it('is unaffected by how the data is chunked', () => {
    const data = randomBytes(300_000);
    const expected = createHash('sha256').update(data).digest('hex');

    for (const chunkSize of [1, 7, 64, 1024, 65_536]) {
      const stream = new Sha256Stream();
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        stream.update(new Uint8Array(data.subarray(offset, offset + chunkSize)));
      }
      expect(stream.hex()).toBe(expected);
    }
  });

  it('handles inputs long enough to overflow a 32-bit bit-length', () => {
    // A file's bit length passes 2^32 at 512 MB. Getting the high word wrong there
    // would corrupt the digest of every large upload, which is exactly the case this
    // hasher exists for, so the boundary is crossed for real rather than mocked.
    const stream = new Sha256Stream();
    const node = createHash('sha256');
    const chunk = new Uint8Array(4 * 1024 * 1024);
    chunk.fill(0x61);
    for (let i = 0; i < 130; i += 1) {
      stream.update(chunk);
      node.update(chunk);
    }
    expect(stream.hex()).toBe(node.digest('hex'));
  }, 60_000);

  it('refuses to be used after digest()', () => {
    const stream = new Sha256Stream().update(new Uint8Array([1, 2, 3]));
    stream.digest();
    expect(() => stream.update(new Uint8Array([4]))).toThrow(/after digest/);
    expect(() => stream.digest()).toThrow(/twice/);
  });
});

describe('fileFingerprint', () => {
  it('is stable for the same file', () => {
    expect(fileFingerprint('IMG_4821.MOV', 2_500_000_000, 1757000000000)).toBe(
      fileFingerprint('IMG_4821.MOV', 2_500_000_000, 1757000000000),
    );
  });

  it('changes when any component changes', () => {
    const base = fileFingerprint('IMG_4821.MOV', 2_500_000_000, 1757000000000);
    expect(fileFingerprint('IMG_4822.MOV', 2_500_000_000, 1757000000000)).not.toBe(base);
    expect(fileFingerprint('IMG_4821.MOV', 2_500_000_001, 1757000000000)).not.toBe(base);
    expect(fileFingerprint('IMG_4821.MOV', 2_500_000_000, 1757000000001)).not.toBe(base);
  });
});
