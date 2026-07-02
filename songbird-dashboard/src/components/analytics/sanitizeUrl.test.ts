import { describe, it, expect } from 'vitest';
import { sanitizeUrl } from './sanitizeUrl';

describe('sanitizeUrl', () => {
  it('neutralizes javascript: URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('');
  });

  it('neutralizes javascript: URLs regardless of case', () => {
    expect(sanitizeUrl('JavaScript:alert(1)')).toBe('');
    expect(sanitizeUrl('JAVASCRIPT:alert(document.cookie)')).toBe('');
  });

  it('neutralizes javascript: URLs obfuscated with control chars/whitespace', () => {
    expect(sanitizeUrl('java\tscript:alert(1)')).toBe('');
    expect(sanitizeUrl('  javascript:alert(1)')).toBe('');
    expect(sanitizeUrl('java\nscript:alert(1)')).toBe('');
  });

  it('neutralizes other dangerous schemes', () => {
    expect(sanitizeUrl('vbscript:msgbox(1)')).toBe('');
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(sanitizeUrl('file:///etc/passwd')).toBe('');
  });

  it('preserves safe http/https URLs', () => {
    expect(sanitizeUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('preserves relative and anchor links', () => {
    expect(sanitizeUrl('/devices/abc123')).toBe('/devices/abc123');
    expect(sanitizeUrl('#section')).toBe('#section');
    expect(sanitizeUrl('mailto:ops@example.com')).toBe('mailto:ops@example.com');
  });

  it('handles empty input', () => {
    expect(sanitizeUrl('')).toBe('');
  });
});
