import { safeJsonStringify, sanitizeLogValue } from '../lib/utils/logUtils';

describe('logUtils', () => {
  it('sanitizes values and handles empty input', () => {
    expect(sanitizeLogValue('')).toBe('');
    expect(sanitizeLogValue('Hello, world!')).toBe('Hello world');
    expect(sanitizeLogValue('  A\tB\nC  ')).toBe('A B C');
  });

  it('stringifies payloads and falls back on unserializable values', () => {
    expect(safeJsonStringify({ ok: true })).toBe('{"ok":true}');

    const circular: any = {};
    circular.self = circular;
    const result = safeJsonStringify(circular);
    expect(result).toContain('unserializable device object');
  });
});
