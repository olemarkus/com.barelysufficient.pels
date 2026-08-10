import {
  normalizeDeviceTargetPowerConfigs,
  normalizeTargetPowerSteppedLoadConfig,
} from '../../lib/utils/targetPowerConfig';

describe('normalizeTargetPowerSteppedLoadConfig', () => {
  it('accepts a valid preset config', () => {
    expect(normalizeTargetPowerSteppedLoadConfig({ enabled: true, preset: 'ev_charger_1_phase' }))
      .toEqual({ enabled: true, preset: 'ev_charger_1_phase' });
  });

  it('drops runtime reachability state from the user-authored config', () => {
    expect(normalizeTargetPowerSteppedLoadConfig({
      enabled: true,
      preset: 'ev_charger_1_phase',
      reachability: {
        profileFingerprint: 'ev_charger_1_phase:off=0,32a=7360',
        maxReachedPowerW: 5750,
        probeFailureCount: 2,
        nextProbeAtMs: 123_000,
      },
    })).toEqual({ enabled: true, preset: 'ev_charger_1_phase' });
  });

  it('drops malformed runtime reachability without rejecting the base preset', () => {
    expect(normalizeTargetPowerSteppedLoadConfig({
      enabled: true,
      preset: 'ev_charger_1_phase',
      reachability: {
        profileFingerprint: 'profile',
        maxReachedPowerW: 5750,
        probeFailureCount: 1,
        nextProbeAtMs: 'soon',
      },
    })).toEqual({ enabled: true, preset: 'ev_charger_1_phase' });
  });

  it('accepts manual configs whose range includes zero', () => {
    expect(normalizeTargetPowerSteppedLoadConfig({ min: 0, max: 3680, step: 460 }))
      .toEqual({ min: 0, max: 3680, step: 460 });
    expect(normalizeTargetPowerSteppedLoadConfig({ max: 3680, step: 460 }))
      .toEqual({ max: 3680, step: 460 });
  });

  it('rejects manual configs whose min raises the range above zero', () => {
    expect(normalizeTargetPowerSteppedLoadConfig({ min: 1380, max: 3680, step: 460 }))
      .toBeUndefined();
  });

  it('rejects an enabled range that yields no step ladder', () => {
    // Accepting these is what let a device be classified as a stepped load with
    // nowhere to stand: the config survived, the ladder resolved to nothing.
    expect(normalizeTargetPowerSteppedLoadConfig({ enabled: true, max: 100, step: 500 }))
      .toBeUndefined();
    expect(normalizeTargetPowerSteppedLoadConfig({ max: 0, step: 500 }))
      .toBeUndefined();
    expect(normalizeTargetPowerSteppedLoadConfig({ max: 3680, step: 0 }))
      .toBeUndefined();
    expect(normalizeTargetPowerSteppedLoadConfig({ max: 100_000, step: 1 }))
      .toBeUndefined();
  });

  it('preserves disabled configs even without preset/max/step', () => {
    expect(normalizeTargetPowerSteppedLoadConfig({ enabled: false }))
      .toEqual({ enabled: false });
  });

  it('parses JSON-encoded settings strings', () => {
    expect(normalizeTargetPowerSteppedLoadConfig('{"max":3680,"step":460}'))
      .toEqual({ max: 3680, step: 460 });
  });
});

describe('normalizeDeviceTargetPowerConfigs', () => {
  it('drops malformed configs from the persisted map', () => {
    expect(normalizeDeviceTargetPowerConfigs({
      good: { max: 3680, step: 460 },
      'min-raised': { min: 1380, max: 3680, step: 460 },
      'no-ladder': { enabled: true, max: 100, step: 500 },
      empty: null,
    })).toEqual({
      good: { max: 3680, step: 460 },
    });
  });
});
