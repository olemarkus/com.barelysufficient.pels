import { describe, expect, it } from 'vitest';
import {
  effectiveGridImportLimitKw,
  mainFuseTotalKw,
  resolveMainFuseSetting,
} from '../../packages/shared-domain/src/settings/mainFuse';

describe('main fuse setting', () => {
  it('resolves off whatever size is stored', () => {
    expect(resolveMainFuseSetting('off', 'junk')).toEqual({ state: 'resolved', value: { kind: 'off' } });
  });

  it('needs a known supply with a valid size', () => {
    expect(resolveMainFuseSetting('three_phase_neutral', 25)).toEqual({
      state: 'resolved', value: { kind: 'on', supply: 'three_phase_neutral', amps: 25 },
    });
    expect(resolveMainFuseSetting('three_phase_neutral', 2).state).toBe('malformed');
    expect(resolveMainFuseSetting('three_phase_neutral', undefined).state).toBe('malformed');
    expect(resolveMainFuseSetting('delta', 25).state).toBe('malformed');
  });

  it.each([
    ['one_phase', 40, 9.2],
    ['three_phase_neutral', 25, 17.25],
    ['three_phase_no_neutral', 25, 9.959],
  ] as const)('%s at %d A carries %d kW', (supply, amps, kw) => {
    expect(mainFuseTotalKw({ kind: 'on', supply, amps })).toBeCloseTo(kw, 2);
  });

  it('enforces the lower of the owner limit and the fuse total', () => {
    const fuse = { kind: 'on', supply: 'three_phase_neutral', amps: 25 } as const;
    expect(effectiveGridImportLimitKw(null, { kind: 'off' })).toBeNull();
    expect(effectiveGridImportLimitKw(10, { kind: 'off' })).toBe(10);
    expect(effectiveGridImportLimitKw(null, fuse)).toBe(17.25);
    expect(effectiveGridImportLimitKw(10, fuse)).toBe(10);
    expect(effectiveGridImportLimitKw(20, fuse)).toBe(17.25);
  });
});
