/**
 * Tests for shared utility helpers (parseIntParam, redact, safeStringify).
 *
 * The redact/safeStringify tests guard against sensitive data — the
 * Authorization JWT and request bodies — leaking into CloudWatch logs.
 */

import { describe, it, expect } from 'vitest';
import { parseIntParam, redact, safeStringify } from './utils';

describe('parseIntParam', () => {
  it('returns the parsed value', () => {
    expect(parseIntParam('42', 10)).toBe(42);
  });

  it('falls back to default on missing/invalid input', () => {
    expect(parseIntParam(undefined, 10)).toBe(10);
    expect(parseIntParam('abc', 10)).toBe(10);
    expect(parseIntParam('0', 10)).toBe(10);
    expect(parseIntParam('-5', 10)).toBe(10);
  });

  it('clamps to max when provided', () => {
    expect(parseIntParam('1000', 100, 500)).toBe(500);
    expect(parseIntParam('50', 100, 500)).toBe(50);
  });
});

describe('redact', () => {
  it('redacts the Authorization header (case-insensitive)', () => {
    const event = {
      headers: {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
        'content-type': 'application/json',
      },
    };
    const out = redact(event) as any;
    expect(out.headers.Authorization).toBe('[REDACTED]');
    expect(out.headers['content-type']).toBe('application/json');
  });

  it('redacts lower-cased authorization header key', () => {
    const out = redact({ headers: { authorization: 'Bearer abc.def.ghi' } }) as any;
    expect(out.headers.authorization).toBe('[REDACTED]');
  });

  it('redacts sensitive body fields', () => {
    const body = {
      ssid: 'HomeNetwork',
      password: 'hunter2',
      secret: 'shhh',
      token: 'tok_123',
      normal: 'keep-me',
    };
    const out = redact(body) as any;
    expect(out.ssid).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.normal).toBe('keep-me');
  });

  it('redacts nested sensitive fields', () => {
    const event = {
      body: { config: { wifi: ['ssid', 'pw'], api_key: 'sk-live-xyz' } },
    };
    const out = redact(event) as any;
    expect(out.body.config.wifi).toBe('[REDACTED]');
    expect(out.body.config.api_key).toBe('[REDACTED]');
  });

  it('masks inline Bearer tokens embedded in string values', () => {
    const out = redact('auth=Bearer eyJ0eXAiOiJKV1Q.abc.def rest') as string;
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('eyJ0eXAiOiJKV1Q');
  });

  it('handles arrays without dropping non-sensitive entries', () => {
    const out = redact([{ password: 'x', name: 'a' }, { name: 'b' }]) as any[];
    expect(out[0].password).toBe('[REDACTED]');
    expect(out[0].name).toBe('a');
    expect(out[1].name).toBe('b');
  });

  it('passes through null, undefined, and primitives', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(123)).toBe(123);
    expect(redact(true)).toBe(true);
  });

  it('does not mutate the original object', () => {
    const event = { headers: { Authorization: 'Bearer secret.jwt.token' } };
    redact(event);
    expect(event.headers.Authorization).toBe('Bearer secret.jwt.token');
  });
});

describe('safeStringify', () => {
  it('produces JSON with sensitive fields redacted', () => {
    const event = {
      headers: { Authorization: 'Bearer secret.jwt.token' },
      body: { password: 'hunter2' },
    };
    const s = safeStringify(event);
    expect(s).not.toContain('secret.jwt.token');
    expect(s).not.toContain('hunter2');
    expect(s).toContain('[REDACTED]');
  });

  it('honors the space argument for pretty-printing', () => {
    const s = safeStringify({ a: 1 }, 2);
    expect(s).toContain('\n');
  });
});
