import { describe, expect, it } from 'vitest';
import { classifyPowerSourceSetting } from '../../lib/power/powerSource';

describe('classifyPowerSourceSetting', () => {
  it.each([
    ['homey_energy', 'homey_energy'],
    ['flow', 'flow'],
    ['malformed', 'flow'],
  ] as const)('resolves a non-null raw value %s to %s', (raw, expected) => {
    expect(classifyPowerSourceSetting({
      raw,
      keyPresent: true,
      keyListEmpty: false,
    })).toEqual({ state: 'resolved', value: expected });
  });

  it('resolves absent source to the historical Flow default only with healthy absence evidence', () => {
    expect(classifyPowerSourceSetting({
      raw: undefined,
      keyPresent: false,
      keyListEmpty: false,
    })).toEqual({ state: 'resolved', value: 'flow' });
  });

  it.each([
    ['an existing source key', true, false, 'missing_existing_key'],
    ['an empty key list', false, true, 'empty_key_list'],
  ] as const)('classifies absent source with %s as suspect', (_label, keyPresent, keyListEmpty, reason) => {
    expect(classifyPowerSourceSetting({
      raw: undefined,
      keyPresent,
      keyListEmpty,
    })).toEqual({ state: 'suspect', reason });
  });
});
