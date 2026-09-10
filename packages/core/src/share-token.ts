import { SHARE_ALPHABET, SHARE_SLUG_LENGTH } from "./types";
import { sha256Hex } from "./sha256";

export function encodeShareSlug(bytes: Uint8Array, length = SHARE_SLUG_LENGTH): string {
  if (bytes.length < 8) throw new Error("Share slug needs at least 8 random bytes");
  let out = "";
  for (let i = 0; out.length < length; i += 1) {
    out += SHARE_ALPHABET[bytes[i % bytes.length]! % SHARE_ALPHABET.length];
  }
  return out;
}

export function createShareToken(randomBytes: Uint8Array): { token: string; tokenHash: string } {
  const token = encodeShareSlug(randomBytes);
  return { token, tokenHash: hashShareToken(token) };
}

export function hashShareToken(token: string): string {
  return sha256Hex(token);
}
