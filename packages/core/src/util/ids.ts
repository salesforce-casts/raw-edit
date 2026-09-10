/**
 * Prefixed, lexicographically sortable ids (ULID-shaped: 48-bit timestamp + randomness).
 * Generated in application code so a client can reference a row before it is committed.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const RANDOM_LENGTH = 16;

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?<T extends ArrayBufferView>(array: T): T } }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function encodeTime(now: number): string {
  let time = now;
  let out = '';
  for (let i = 9; i >= 0; i -= 1) {
    const mod = time % 32;
    out = ALPHABET[mod]! + out;
    time = (time - mod) / 32;
  }
  return out;
}

export function ulid(now = Date.now()): string {
  const bytes = randomBytes(RANDOM_LENGTH);
  let random = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) random += ALPHABET[bytes[i]! % 32]!;
  return encodeTime(now) + random;
}

export type IdPrefix =
  | 'usr' | 'vid' | 'src' | 'ups' | 'job' | 'trx' | 'seg' | 'wrd'
  | 'tak' | 'tkm' | 'edd' | 'eds' | 'exp' | 'shr' | 'sub' | 'usg';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

/**
 * Short, URL-safe, unambiguous slug for share links (`app.com/v/abc123`).
 *
 * The alphabet drops the characters people misread aloud (i/l/1, o/0). Twelve
 * characters of a 31-symbol alphabet is about 59 bits, which is the point of
 * unguessability for a link that is the only thing protecting a private video —
 * ten characters would be 49, and these links get pasted into group chats.
 */
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function shareSlug(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length]!;
  return out;
}
