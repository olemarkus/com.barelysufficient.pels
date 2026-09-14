import { describe, expect, it } from 'vitest';
import { readShedBehaviorsSetting } from '../../lib/home/shedBehaviorsRead';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';

// The seed writes the whole map back, so only a store that demonstrably never
// held the key may read as an empty map. Everything else is unavailable.
const settingsWith = (value: unknown, keys: string[]): SettingsPort => ({
  get: () => value,
  set: () => {},
  unset: () => {},
  getKeys: () => keys,
});

describe('readShedBehaviorsSetting', () => {
  it('reads a stored map through the key owner', () => {
    expect(readShedBehaviorsSetting(settingsWith(
      { heater: { action: 'set_temperature', temperature: 16 } },
      ['overshoot_behaviors'],
    ))).toEqual({
      state: 'resolved',
      behaviors: { heater: { action: 'set_temperature', temperature: 16, coolingTemperature: 28 } },
    });
  });

  it('reads an empty map only when the key list proves the key was never written', () => {
    expect(readShedBehaviorsSetting(settingsWith(null, ['operating_mode'])))
      .toEqual({ state: 'resolved', behaviors: {} });
    expect(readShedBehaviorsSetting(settingsWith(null, ['operating_mode', 'overshoot_behaviors'])))
      .toEqual({ state: 'unavailable' });
    expect(readShedBehaviorsSetting(settingsWith(null, []))).toEqual({ state: 'unavailable' });
  });

  it('treats a present value that is not a map as unavailable, even when the key list omits the key', () => {
    // Corruption is not absence: reading it as an empty map would let the seed
    // replace the stored value with a map of its own.
    expect(readShedBehaviorsSetting(settingsWith('garbage', ['operating_mode']))).toEqual({ state: 'unavailable' });
  });
});
