import { describe, expect, it, vi } from 'vitest';
import { resolvePvForecastSourceSetting } from '../../setup/pvForecastSourceSetting';

const settingsWith = (value: unknown): { get: (key: string) => unknown } => ({ get: () => value });

describe('resolvePvForecastSourceSetting', () => {
  it('passes through the three valid values in one read', () => {
    for (const value of ['auto', 'homey_energy', 'learned'] as const) {
      const get = vi.fn(() => value);
      expect(resolvePvForecastSourceSetting({ get })).toBe(value);
      expect(get).toHaveBeenCalledTimes(1); // recognised ⇒ no retry
    }
  });

  it('classifies a never-written key as auto — the same nothing twice', () => {
    // Homey answers an unset key with null, and undefined is the other absence.
    for (const absent of [null, undefined]) {
      const get = vi.fn(() => absent);
      expect(resolvePvForecastSourceSetting({ get })).toBe('auto');
      expect(get).toHaveBeenCalledTimes(2); // unrecognised ⇒ read again
    }
  });

  it('recovers a PINNED source from a transient first-read miss', () => {
    // The defect this retry exists for: the key IS written, but one read comes
    // back empty. Defaulting there would silently un-pin the owner's choice.
    for (const pinned of ['learned', 'homey_energy'] as const) {
      const get = vi.fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(pinned);
      expect(resolvePvForecastSourceSetting({ get })).toBe(pinned);
      expect(get).toHaveBeenCalledTimes(2);
    }
  });

  it('classifies junk as auto', () => {
    expect(resolvePvForecastSourceSetting(settingsWith('openmeteo'))).toBe('auto');
    expect(resolvePvForecastSourceSetting(settingsWith(1))).toBe('auto');
    expect(resolvePvForecastSourceSetting(settingsWith({ source: 'learned' }))).toBe('auto');
  });

  it('absorbs a thrown settings read, and still recovers if only the first throws', () => {
    const throwing = { get: () => { throw new Error('transient settings.get failure'); } };
    expect(resolvePvForecastSourceSetting(throwing)).toBe('auto');

    const get = vi.fn()
      .mockImplementationOnce(() => { throw new Error('transient settings.get failure'); })
      .mockReturnValueOnce('learned');
    expect(resolvePvForecastSourceSetting({ get })).toBe('learned');
  });
});
