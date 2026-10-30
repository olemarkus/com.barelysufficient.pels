import { describe, expect, it } from 'vitest';
import { classifyPowerSourceChoice, classifyPowerSourceSetting } from '../../lib/power/powerSource';

describe('classifyPowerSourceSetting', () => {
  it.each([
    ['homey_energy', 'homey_energy'],
    ['flow', 'flow'],
    ['malformed', 'flow'],
  ] as const)('resolves a non-null raw value %s to %s', (raw, expected) => {
    expect(classifyPowerSourceSetting({
      raw,
      keyPresent: true,
    })).toEqual({ state: 'resolved', value: expected });
  });

  it('resolves absent source to the historical Flow default only when the key list does not carry the key', () => {
    expect(classifyPowerSourceSetting({
      raw: undefined,
      keyPresent: false,
    })).toEqual({ state: 'resolved', value: 'flow' });
  });

  it('classifies an absent source whose key is listed as suspect', () => {
    expect(classifyPowerSourceSetting({
      raw: undefined,
      keyPresent: true,
    })).toEqual({ state: 'suspect', reason: 'missing_existing_key' });
  });
});

describe('classifyPowerSourceChoice', () => {
  it('reports a non-null raw value as chosen, normalized (a malformed value is a Flow choice)', () => {
    expect(classifyPowerSourceChoice({ raw: 'homey_energy', keyPresent: true }))
      .toEqual({ state: 'chosen', value: 'homey_energy' });
    expect(classifyPowerSourceChoice({ raw: 'malformed', keyPresent: true }))
      .toEqual({ state: 'chosen', value: 'flow' });
  });

  it('reports a never-written key as unset only when the key list does not carry the key', () => {
    expect(classifyPowerSourceChoice({ raw: null, keyPresent: false }))
      .toEqual({ state: 'unset' });
    expect(classifyPowerSourceChoice({ raw: undefined, keyPresent: true }))
      .toEqual({ state: 'suspect', reason: 'missing_existing_key' });
  });
});
