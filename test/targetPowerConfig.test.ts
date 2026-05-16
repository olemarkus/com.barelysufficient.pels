import {
  normalizeDeviceTargetPowerConfigs,
  normalizeTargetPowerSteppedLoadConfig,
} from '../lib/utils/targetPowerConfig';

describe('normalizeTargetPowerSteppedLoadConfig', () => {
  it('accepts a valid preset config', () => {
    expect(normalizeTargetPowerSteppedLoadConfig({ enabled: true, preset: 'ev_charger_1_phase' }))
      .toEqual({ enabled: true, preset: 'ev_charger_1_phase' });
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
      empty: null,
    })).toEqual({
      good: { max: 3680, step: 460 },
    });
  });
});
