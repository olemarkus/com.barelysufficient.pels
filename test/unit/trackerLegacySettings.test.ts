import { unsetLegacyPowerTrackerKeys } from '../../lib/power/trackerLegacySettings';

const settingsOf = (keys: string[]) => {
  const present = new Set(keys);
  return {
    settings: { getKeys: () => [...present], unset: (key: string) => { present.delete(key); } },
    remaining: () => [...present].sort(),
  };
};

describe('unsetLegacyPowerTrackerKeys', () => {
  it('unsets the bare and every home-suffixed tracker key, and nothing else', () => {
    const { settings, remaining } = settingsOf([
      'power_tracker_state', 'power_tracker_state:h_a', 'power_tracker_state:h_b',
      'power_source', 'power_tracker_stateful_other',
    ]);
    expect(unsetLegacyPowerTrackerKeys(settings)).toBe(3);
    expect(remaining()).toEqual(['power_source', 'power_tracker_stateful_other']);
  });

  it('is a no-op on an install that never wrote the key', () => {
    const { settings, remaining } = settingsOf(['power_source']);
    expect(unsetLegacyPowerTrackerKeys(settings)).toBe(0);
    expect(remaining()).toEqual(['power_source']);
  });

  it('swallows a throwing SDK: the next boot retries', () => {
    const settings = { getKeys: () => { throw new Error('sdk down'); }, unset: () => {} };
    expect(unsetLegacyPowerTrackerKeys(settings)).toBe(0);
  });
});
