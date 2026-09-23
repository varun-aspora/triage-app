// AES-SIV (RFC 5297) on node:crypto, deterministic mode.
//
// The key is K1 || K2: K1 keys AES-CMAC inside S2V, K2 keys AES-CTR. A
// 32-byte key uses AES-128 for both halves, 48 bytes AES-192, 64 bytes
// AES-256. The sealed output is the 16-byte synthetic IV (the tag) followed by
// the ciphertext, which has the same length as the plaintext.
//
// Errors never carry key bytes, plaintext or ciphertext.
import { createCipheriv, timingSafeEqual } from 'node:crypto';

export const SIV_TAG_BYTES = 16;
const BLOCK = 16;
// RFC 5297 caps S2V at 127 components (the associated data plus the plaintext).
const MAX_AD_COMPONENTS = 126;

export class AesSivError extends Error {
  override readonly name = 'AesSivError';
  readonly reason: 'bad_key' | 'too_many_ad' | 'too_short' | 'auth_failed';

  constructor(reason: AesSivError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

type Bytes = Uint8Array;

function aesName(halfKey: Bytes, mode: 'ecb' | 'ctr'): string {
  return `aes-${halfKey.length * 8}-${mode}`;
}

function splitKey(key: Bytes): { macKey: Bytes; ctrKey: Bytes } {
  if (key.length !== 32 && key.length !== 48 && key.length !== 64) {
    throw new AesSivError('bad_key', 'AES-SIV key must be 32, 48 or 64 bytes');
  }
  const half = key.length / 2;
  return { macKey: key.subarray(0, half), ctrKey: key.subarray(half) };
}

/** Raw AES block encryption. ECB without padding keeps no state between blocks, so one cipher serves a whole CMAC. */
function blockCipher(key: Bytes): (block: Bytes) => Bytes {
  const c = createCipheriv(aesName(key, 'ecb'), key, null);
  c.setAutoPadding(false);
  return (block) => new Uint8Array(c.update(block));
}

/** Doubling in GF(2^128) with the polynomial x^128 + x^7 + x^2 + x + 1. */
function dbl(block: Bytes): Bytes {
  const out = new Uint8Array(BLOCK);
  let carry = 0;
  for (let i = BLOCK - 1; i >= 0; i--) {
    const b = block[i] as number;
    out[i] = ((b << 1) & 0xff) | carry;
    carry = b >>> 7;
  }
  if (carry === 1) out[BLOCK - 1] = (out[BLOCK - 1] as number) ^ 0x87;
  return out;
}

function xorInto(target: Bytes, source: Bytes, offset = 0): void {
  for (let i = 0; i < source.length; i++) target[offset + i] = (target[offset + i] as number) ^ (source[i] as number);
}

function pad(partial: Bytes): Bytes {
  const out = new Uint8Array(BLOCK);
  out.set(partial);
  out[partial.length] = 0x80;
  return out;
}

/** AES-CMAC (RFC 4493) with AES-128, -192 or -256 depending on the key length. */
export function aesCmac(key: Bytes, message: Bytes): Bytes {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new AesSivError('bad_key', 'AES-CMAC key must be 16, 24 or 32 bytes');
  }
  const enc = blockCipher(key);
  const l = enc(new Uint8Array(BLOCK));
  const k1 = dbl(l);
  const k2 = dbl(k1);

  const blocks = message.length === 0 ? 1 : Math.ceil(message.length / BLOCK);
  const complete = message.length > 0 && message.length % BLOCK === 0;
  const last = complete
    ? message.slice((blocks - 1) * BLOCK)
    : pad(message.subarray((blocks - 1) * BLOCK));
  xorInto(last, complete ? k1 : k2);

  let x: Bytes = new Uint8Array(BLOCK);
  for (let i = 0; i < blocks - 1; i++) {
    xorInto(x, message.subarray(i * BLOCK, (i + 1) * BLOCK));
    x = enc(x);
  }
  xorInto(x, last);
  return enc(x);
}

/** S2V over the associated-data components followed by the plaintext (RFC 5297 section 2.4). */
function s2v(macKey: Bytes, adList: readonly Bytes[], plaintext: Bytes): Bytes {
  let d = aesCmac(macKey, new Uint8Array(BLOCK));
  for (const ad of adList) {
    d = dbl(d);
    xorInto(d, aesCmac(macKey, ad));
  }
  let t: Bytes;
  if (plaintext.length >= BLOCK) {
    t = plaintext.slice();
    xorInto(t, d, plaintext.length - BLOCK);
  } else {
    t = dbl(d);
    xorInto(t, pad(plaintext));
  }
  return aesCmac(macKey, t);
}

function ctr(ctrKey: Bytes, iv: Bytes, data: Bytes): Bytes {
  const q = iv.slice();
  // Clear bit 63 and bit 31 (counted from the right) so the counter can wrap freely.
  q[8] = (q[8] as number) & 0x7f;
  q[12] = (q[12] as number) & 0x7f;
  const c = createCipheriv(aesName(ctrKey, 'ctr'), ctrKey, q);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
}

function checkAd(adList: readonly Bytes[]): void {
  if (adList.length > MAX_AD_COMPONENTS) {
    throw new AesSivError('too_many_ad', `AES-SIV takes at most ${MAX_AD_COMPONENTS} associated-data components`);
  }
}

/** Seals plaintext. Returns tag (16 bytes) || ciphertext. Deterministic for the same key, AD and plaintext. */
export function sivSeal(key: Bytes, adList: readonly Bytes[], plaintext: Bytes): Uint8Array {
  const { macKey, ctrKey } = splitKey(key);
  checkAd(adList);
  const tag = s2v(macKey, adList, plaintext);
  const out = new Uint8Array(SIV_TAG_BYTES + plaintext.length);
  out.set(tag);
  out.set(ctr(ctrKey, tag, plaintext), SIV_TAG_BYTES);
  return out;
}

/** Opens tag || ciphertext. Throws AesSivError 'auth_failed' when the tag does not match. */
export function sivOpen(key: Bytes, adList: readonly Bytes[], sealed: Bytes): Uint8Array {
  const { macKey, ctrKey } = splitKey(key);
  checkAd(adList);
  if (sealed.length < SIV_TAG_BYTES) {
    throw new AesSivError('too_short', 'AES-SIV input is shorter than the 16-byte tag');
  }
  const tag = sealed.subarray(0, SIV_TAG_BYTES);
  const plaintext = ctr(ctrKey, tag, sealed.subarray(SIV_TAG_BYTES));
  const expected = s2v(macKey, adList, plaintext);
  if (!timingSafeEqual(expected, tag)) {
    plaintext.fill(0);
    throw new AesSivError('auth_failed', 'AES-SIV authentication failed');
  }
  return plaintext;
}
