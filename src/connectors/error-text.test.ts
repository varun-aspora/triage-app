import { describe, expect, test } from 'bun:test';
import { ConnectorError } from './types.ts';
import { errorText, excerpt, MAX_ERROR_TEXT_CHARS, safeErrorText, scrubSecrets, stripAddresses } from './error-text.ts';

describe('scrubSecrets', () => {
  test('takes out the given values, longest first', () => {
    const dsn = 'postgres://ro_user:pw-SEEDED-1@db.internal.example:5432/app';
    expect(scrubSecrets(`could not connect to ${dsn} as ro_user`, [dsn, 'ro_user', 'pw-SEEDED-1'])).toBe(
      'could not connect to <redacted> as <redacted>',
    );
  });

  test('ignores values shorter than 3 characters', () => {
    expect(scrubSecrets('a b c', ['a', 'b'])).toBe('a b c');
  });

  test('takes out URL credentials even when the value was not given', () => {
    expect(scrubSecrets('GET https://svc:tok-SEEDED@api.example.com/v1 failed')).toBe('GET https://<redacted>@api.example.com/v1 failed');
    expect(scrubSecrets('postgresql://user:p%40ss@host/db')).toBe('postgresql://<redacted>@host/db');
  });

  test('takes out Authorization, Cookie and API-key header values in every form', () => {
    expect(scrubSecrets('Authorization: Bearer abc.def.ghi-SEEDED')).toBe('Authorization: <redacted>');
    expect(scrubSecrets('cookie: session=s-SEEDED; theme=dark\nnext line')).toBe('cookie: <redacted>\nnext line');
    expect(scrubSecrets('{"authorization":"Basic dXNlcjpwYXNz","x":1}')).toBe('{"authorization":"<redacted>","x":1}');
    expect(scrubSecrets('x-api-key=k-SEEDED-42')).toBe('x-api-key=<redacted>');
    expect(scrubSecrets('Set-Cookie: sid=zzz-SEEDED; HttpOnly')).toBe('Set-Cookie: <redacted>');
  });

  test('takes out bare bearer tokens and libpq passwords', () => {
    expect(scrubSecrets('sent Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig and failed')).toBe('sent Bearer <redacted> and failed');
    expect(scrubSecrets("host=db user=ro password='s3cr3t-SEEDED' dbname=app")).toBe('host=db user=ro password=<redacted> dbname=app');
  });

  test('turns control characters into spaces', () => {
    expect(scrubSecrets('a\u0000b\u001bc')).toBe('a b c');
  });

  test('leaves ordinary error text alone', () => {
    const text = 'column "stauts" does not exist. Hint: Perhaps you meant to reference the column "t.status".';
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe('stripAddresses', () => {
  test('replaces URLs, IPv4 and IPv6 addresses, keeping punctuation after a URL', () => {
    expect(stripAddresses('dial 10.1.2.3:443 and [fe80::1]:5432 via https://qw.internal/api).')).toBe('dial <host> and <host> via <url>).');
  });
});

describe('excerpt and safeErrorText', () => {
  test('folds whitespace and caps the length', () => {
    expect(excerpt('  a \n\n b\tc  ')).toBe('a b c');
    const long = excerpt('x'.repeat(MAX_ERROR_TEXT_CHARS + 50));
    expect(long).toHaveLength(MAX_ERROR_TEXT_CHARS + 3);
    expect(long.endsWith('...')).toBe(true);
    expect(excerpt('abcdef', 3)).toBe('abc...');
  });

  test('safeErrorText scrubs before it cuts, so a cut never leaves half a secret', () => {
    const secret = 'S'.repeat(40);
    const out = safeErrorText(`${'a'.repeat(10)} ${secret} ${'b'.repeat(40)}`, [secret], 25);
    expect(out).toBe('aaaaaaaaaa <redacted> bbb...');
  });
});

describe('errorText', () => {
  test('joins an error with its causes and adds a cause code missing from its message', () => {
    const cause = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    const err = Object.assign(new TypeError('fetch failed', { cause }), { code: 'unreachable' });
    expect(errorText(err)).toBe('fetch failed: connect refused (ECONNREFUSED)');
  });

  test('skips a cause already in the text and handles strings and non-errors', () => {
    const err = new Error('boom: inner', { cause: new Error('inner') });
    expect(errorText(err)).toBe('boom: inner');
    expect(errorText('plain')).toBe('plain');
    expect(errorText(undefined)).toBe('');
    expect(errorText(42)).toBe('');
  });
});

describe('errorText and causes', () => {
  test('a ConnectorError gives its own message only, never the raw cause it attaches', () => {
    const raw = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND qw-secret.internal'), { code: 'ENOTFOUND' }) });
    const err = new ConnectorError('unreachable', 'Quickwit at SSFB_QW_URL could not be reached: fetch failed: getaddrinfo ENOTFOUND <redacted>', { cause: raw });
    expect(errorText(err)).toBe('Quickwit at SSFB_QW_URL could not be reached: fetch failed: getaddrinfo ENOTFOUND <redacted>');
    expect(errorText(err)).not.toContain('qw-secret');
  });

  test('the causes of any other error are scrubbed with the known secrets and addresses', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.bank-secret.example at https://u:p@api.bank-secret.example/x'), { code: 'ENOTFOUND' });
    const out = errorText(new Error('fetch failed', { cause }), ['bank-secret']);
    expect(out).toStartWith('fetch failed: getaddrinfo ENOTFOUND <host>');
    expect(out).not.toContain('bank-secret');
    expect(out).not.toContain('u:p');
  });

  test('a bare host name in a cause goes even when no secret names it', () => {
    const cause = new Error('connect to cbs-gw.internal port 8443 failed');
    expect(errorText(new Error('boom', { cause }))).toBe('boom: connect to <host> port 8443 failed');
  });
});

describe('scrubSecrets tokens', () => {
  test('a JWT goes wherever it appears', () => {
    expect(scrubSecrets('id eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_ghi rejected')).toBe('id <redacted> rejected');
  });

  test('an opaque run after token, session or refresh goes; the word stays', () => {
    expect(scrubSecrets('{"refresh_token":"1//0gAbCdEfGh1234567890"}')).toBe('{"refresh_token":"<redacted>"}');
    expect(scrubSecrets('session=Ab12Cd34Ef56Gh78Ij90; path=/')).toBe('session=<redacted>; path=/');
    expect(scrubSecrets('token a1b2c3d4e5f6g7h8i9j0 expired')).toBe('token <redacted> expired');
  });

  test('plain words after token are kept', () => {
    const text = 'token refresh failed: 400 Bad Request; unexpected token at position 12';
    expect(scrubSecrets(text)).toBe(text);
  });
});

describe('stripAddresses host names', () => {
  test('curl, getaddrinfo and TLS wordings lose the host', () => {
    expect(stripAddresses('curl: (6) Could not resolve host: cbs-gw.bank.local')).toBe('curl: (6) Could not resolve host: <host>');
    expect(stripAddresses('curl: (7) Failed to connect to cbs-gw port 8443 after 3 ms')).toBe('curl: (7) Failed to connect to <host> port 8443 after 3 ms');
    expect(stripAddresses('getaddrinfo EAI_AGAIN db-primary')).toBe('getaddrinfo EAI_AGAIN <host>');
    expect(stripAddresses("altnames: Host: db.internal. is not in the cert's altnames: DNS:*.rds.example.com")).toBe(
      "altnames: Host: <host> is not in the cert's altnames: DNS:<host>",
    );
  });

  test('ordinary words after "connect to" stay', () => {
    expect(stripAddresses('could not connect to server: Connection refused')).toBe('could not connect to server: Connection refused');
  });
});
