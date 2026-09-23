import { describe, expect, test } from 'bun:test';
import { AesSivError, aesCmac, SIV_TAG_BYTES, sivOpen, sivSeal } from './aes-siv.ts';

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s.replace(/\s/g, ''), 'hex'));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

// RFC 5297 Appendix A.1: deterministic authenticated encryption, one AD component.
const A1 = {
  key: hex('fffefdfc fbfaf9f8 f7f6f5f4 f3f2f1f0 f0f1f2f3 f4f5f6f7 f8f9fafb fcfdfeff'),
  ad: hex('10111213 14151617 18191a1b 1c1d1e1f 20212223 24252627'),
  plaintext: hex('11223344 55667788 99aabbcc ddee'),
  output: '85632d07c6e8f37f950acd320a2ecc93' + '40c02b9690c4dc04daef7f6afe5c',
};

// RFC 5297 Appendix A.2: three AD components (the nonce is the last one) and a plaintext over one block.
const A2 = {
  key: hex('7f7e7d7c 7b7a7978 77767574 73727170 40414243 44454647 48494a4b 4c4d4e4f'),
  ad: [
    hex('00112233 44556677 8899aabb ccddeeff deaddada deaddada ffeeddcc bbaa9988 77665544 33221100'),
    hex('10203040 50607080 90a0'),
    hex('09f91102 9d74e35b d84156c5 635688c0'),
  ],
  plaintext: hex(
    '74686973 20697320 736f6d65 20706c61 696e7465 78742074 6f20656e 63727970 74207573 696e6720 5349562d 414553',
  ),
  output:
    '7bdb6e3b432667eb06f4d14bff2fbd0f' +
    'cb900f2fddbe404326601965c889bf17dba77ceb094fa663b7a3f748ba8af829ea64ad544a272e9c485b62a3fd5c0d',
};

describe('RFC 5297 vectors', () => {
  test('A.1 seals to the published output and opens back', () => {
    const sealed = sivSeal(A1.key, [A1.ad], A1.plaintext);
    expect(toHex(sealed)).toBe(A1.output);
    expect(toHex(sivOpen(A1.key, [A1.ad], sealed))).toBe(toHex(A1.plaintext));
  });

  test('A.2 with several AD components and a multi-block plaintext', () => {
    const sealed = sivSeal(A2.key, A2.ad, A2.plaintext);
    expect(toHex(sealed)).toBe(A2.output);
    expect(toHex(sivOpen(A2.key, A2.ad, sealed))).toBe(toHex(A2.plaintext));
  });

  test('the output is the 16-byte tag followed by a ciphertext as long as the plaintext', () => {
    const sealed = sivSeal(A1.key, [A1.ad], A1.plaintext);
    expect(sealed.length).toBe(SIV_TAG_BYTES + A1.plaintext.length);
    expect(toHex(sealed.subarray(0, SIV_TAG_BYTES))).toBe('85632d07c6e8f37f950acd320a2ecc93');
  });
});

describe('AES-CMAC subkeys (RFC 4493 vectors)', () => {
  const key = hex('2b7e1516 28aed2a6 abf71588 09cf4f3c');
  const msg = hex(
    '6bc1bee2 2e409f96 e93d7e11 7393172a ae2d8a57 1e03ac9c 9eb76fac 45af8e51 30c81c46 a35ce411 e5fbc119 1a0a52ef f69f2445 df4f9b17 ad2b417b e66c3710',
  );
  const cases: [string, number, string][] = [
    ['empty message (padded, K2)', 0, 'bb1d6929e95937287fa37d129b756746'],
    ['one full block (K1)', 16, '070a16b46b4d4144f79bdd9dd04a287c'],
    ['40 bytes, last block partial (K2)', 40, 'dfa66747de9ae63030ca32611497c827'],
    ['four full blocks (K1)', 64, '51f0bebf7e3b9d92fc49741779363cfe'],
  ];
  for (const [name, len, want] of cases) {
    test(name, () => {
      expect(toHex(aesCmac(key, msg.subarray(0, len)))).toBe(want);
    });
  }

  test('does not change the message it is given', () => {
    const copy = msg.slice(0, 40);
    aesCmac(key, copy);
    expect(toHex(copy)).toBe(toHex(msg.subarray(0, 40)));
  });

  test('refuses a key that is not an AES key size', () => {
    expect(() => aesCmac(new Uint8Array(15), msg)).toThrow(AesSivError);
  });
});

describe('plaintext lengths', () => {
  const keys = [32, 48, 64].map((n) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff)));

  for (const key of keys) {
    test(`empty plaintext seals to a bare tag and opens with a ${key.length}-byte key`, () => {
      const sealed = sivSeal(key, [], new Uint8Array(0));
      expect(sealed.length).toBe(SIV_TAG_BYTES);
      expect(sivOpen(key, [], sealed).length).toBe(0);
    });
  }

  for (const len of [1, 15, 16, 17, 31, 32, 33, 100]) {
    test(`${len}-byte plaintext round-trips with no AD and is deterministic`, () => {
      const key = keys[2] as Uint8Array;
      const pt = new Uint8Array(Array.from({ length: len }, (_, i) => i & 0xff));
      const a = sivSeal(key, [], pt);
      const b = sivSeal(key, [], pt);
      expect(toHex(a)).toBe(toHex(b));
      expect(toHex(sivOpen(key, [], a))).toBe(toHex(pt));
    });
  }

  test('an AES-192 key gives a different result from AES-128 and AES-256 for the same input', () => {
    const pt = new Uint8Array([1, 2, 3]);
    const outs = keys.map((k) => toHex(sivSeal(k, [], pt)));
    expect(new Set(outs).size).toBe(3);
  });
});

describe('refusals and tamper detection', () => {
  test('keys that are not 32, 48 or 64 bytes are refused', () => {
    for (const n of [0, 16, 24, 31, 33, 63, 65]) {
      expect(() => sivSeal(new Uint8Array(n), [], new Uint8Array(1))).toThrow('AES-SIV key must be 32, 48 or 64 bytes');
      expect(() => sivOpen(new Uint8Array(n), [], new Uint8Array(16))).toThrow(AesSivError);
    }
  });

  test('a flipped bit anywhere in the tag or ciphertext fails authentication', () => {
    const sealed = sivSeal(A1.key, [A1.ad], A1.plaintext);
    for (let i = 0; i < sealed.length; i++) {
      const bad = sealed.slice();
      bad[i] = (bad[i] as number) ^ 0x01;
      let caught: unknown;
      try {
        sivOpen(A1.key, [A1.ad], bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AesSivError);
      expect((caught as AesSivError).reason).toBe('auth_failed');
    }
  });

  test('wrong AD, missing AD or a wrong key fails authentication', () => {
    const sealed = sivSeal(A1.key, [A1.ad], A1.plaintext);
    expect(() => sivOpen(A1.key, [], sealed)).toThrow('AES-SIV authentication failed');
    expect(() => sivOpen(A1.key, [A1.ad, A1.ad], sealed)).toThrow('AES-SIV authentication failed');
    const otherAd = A1.ad.slice();
    otherAd[0] = 0;
    expect(() => sivOpen(A1.key, [otherAd], sealed)).toThrow('AES-SIV authentication failed');
    // Byte 3 is in the CMAC half, byte 20 in the CTR half.
    for (const at of [3, 20]) {
      const otherKey = A1.key.slice();
      otherKey[at] = (otherKey[at] as number) ^ 0x80;
      expect(() => sivOpen(otherKey, [A1.ad], sealed)).toThrow('AES-SIV authentication failed');
    }
  });

  test('input shorter than the tag is refused', () => {
    let caught: unknown;
    try {
      sivOpen(A1.key, [], new Uint8Array(15));
    } catch (err) {
      caught = err;
    }
    expect((caught as AesSivError).reason).toBe('too_short');
  });

  test('more than 126 AD components are refused', () => {
    const ad = Array.from({ length: 127 }, () => new Uint8Array(1));
    expect(() => sivSeal(A1.key, ad, new Uint8Array(1))).toThrow(AesSivError);
    expect(() => sivSeal(A1.key, ad.slice(1), new Uint8Array(1))).not.toThrow();
  });

  test('error messages carry no key, plaintext or ciphertext bytes', () => {
    const sealed = sivSeal(A1.key, [A1.ad], A1.plaintext);
    sealed[0] = (sealed[0] as number) ^ 1;
    let message = '';
    try {
      sivOpen(A1.key, [A1.ad], sealed);
    } catch (err) {
      message = `${(err as Error).message} ${(err as Error).stack ?? ''}`;
    }
    for (const secret of [toHex(A1.key), toHex(A1.plaintext), toHex(sealed), toHex(A1.key.subarray(0, 16))]) {
      expect(message).not.toContain(secret);
    }
  });
});
