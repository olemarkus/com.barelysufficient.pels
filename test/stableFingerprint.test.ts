import { toStableFingerprint } from '../lib/utils/stableFingerprint';

describe('toStableFingerprint', () => {
  it('produces the same fingerprint for objects with different key order', () => {
    const first = { b: 1, a: 2, nested: { y: 'x', x: 'y' } };
    const second = { nested: { x: 'y', y: 'x' }, a: 2, b: 1 };

    expect(toStableFingerprint(first)).toBe(toStableFingerprint(second));
  });

  it('distinguishes values containing separator-like characters', () => {
    const first = { 'a:b,c}': ['x,y:z', { '}': ':,{' }] };
    const second = { 'a:b,c}': ['x,y:z,', { '}': ':{' }] };

    expect(toStableFingerprint(first)).not.toBe(toStableFingerprint(second));
  });

  it('treats shared references as non-circular', () => {
    const shared = { value: 42 };
    const fingerprint = toStableFingerprint({ left: shared, right: shared });

    expect(fingerprint).not.toContain('"circular"');
  });

  it('handles cyclic references without recursing infinitely', () => {
    const cyclic: Array<unknown> = [];
    cyclic.push(cyclic);

    expect(toStableFingerprint(cyclic)).toContain('"circular"');
  });
});
