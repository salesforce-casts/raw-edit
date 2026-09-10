import { describe, expect, it } from "vitest";
import { IncrementalSha256, bitLengthFromByteCount, sha256Hex } from "./sha256";

describe("incremental SHA-256", () => {
  it("matches the empty NIST vector", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the abc NIST vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches the two-block NIST vector", () => {
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("hashes a million a's", () => {
    const hasher = new IncrementalSha256();
    const chunk = new Uint8Array(1000).fill(97);
    for (let i = 0; i < 1000; i += 1) hasher.update(chunk);
    expect(hasher.digestHex()).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("is streaming-equivalent to a one-shot digest", () => {
    const data = new Uint8Array(10_000).map((_, index) => index % 256);
    const one = sha256Hex(data);
    const hasher = new IncrementalSha256();
    hasher.update(data.subarray(0, 17));
    hasher.update(data.subarray(17, 4096));
    hasher.update(data.subarray(4096));
    expect(hasher.digestHex()).toBe(one);
  });

  it("encodes bit length with a high word at the 512 MiB / 2^32-bit boundary", () => {
    const bytes512MiB = 512 * 1024 * 1024;
    const bits = bitLengthFromByteCount(0, bytes512MiB);
    expect(bits.lo).toBe(0);
    expect(bits.hi).toBe(1);
    const justBelow = bitLengthFromByteCount(0, bytes512MiB - 1);
    expect(justBelow.hi).toBe(0);
    expect(justBelow.lo).toBe(((bytes512MiB - 1) * 8) >>> 0);
  });
});
