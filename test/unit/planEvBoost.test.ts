import { normalizeEvBoostSettings } from '../../packages/contracts/src/evBoost';
import { buildBoostPlanDeviceFields, resolveEvBoostActive } from '../../lib/plan/planEvBoost';
import { buildPlanInputDevice, steppedInputDevice } from '../utils/planTestUtils';

describe('normalizeEvBoostSettings', () => {
  it('keeps enabled entries with finite in-range thresholds', () => {
    expect(normalizeEvBoostSettings({
      charger: { enabled: true, boostBelowPercent: 40 },
      disabled: { enabled: false, boostBelowPercent: 20 },
      invalid: { enabled: true, boostBelowPercent: 140 },
    })).toEqual({
      charger: { enabled: true, boostBelowPercent: 40 },
    });
  });
});

describe('resolveEvBoostActive', () => {
  const buildEvDevice = (overrides = {}) => steppedInputDevice({
    deviceClass: 'evcharger',
    deviceType: 'onoff',
    targets: [],
    evChargingState: 'plugged_in_charging',
    stateOfCharge: { percent: 32, status: 'fresh' as const },
    evBoost: { enabled: true, boostBelowPercent: 40 },
    ...overrides,
  });

  it('activates for stepped EV chargers below the threshold with fresh SoC', () => {
    expect(resolveEvBoostActive({
      dev: buildEvDevice(),
      previousActive: false,
    })).toBe(true);
  });

  it('forces boost on for the deferred limit-lower-priority lane, ignoring config/threshold', () => {
    // No evBoost config and SoC above any threshold: only the admission-set forceBoostActive
    // flag activates it (the limit-lower-priority lane).
    expect(resolveEvBoostActive({
      dev: buildEvDevice({ forceBoostActive: true, evBoost: undefined, stateOfCharge: { percent: 90, status: 'fresh' as const } }),
      previousActive: false,
    })).toBe(true);
  });

  it('stops at the target threshold without hysteresis', () => {
    expect(resolveEvBoostActive({
      dev: buildEvDevice({ stateOfCharge: { percent: 40, status: 'fresh' as const } }),
      previousActive: true,
    })).toBe(false);
  });

  it('does not activate for stale, missing, or unplugged EV state', () => {
    expect(resolveEvBoostActive({
      dev: buildEvDevice({ stateOfCharge: { percent: 20, status: 'stale' as const } }),
      previousActive: false,
    })).toBe(false);
    expect(resolveEvBoostActive({
      dev: buildEvDevice({ stateOfCharge: undefined }),
      previousActive: false,
    })).toBe(false);
    expect(resolveEvBoostActive({
      dev: buildEvDevice({ evChargingState: 'plugged_out' }),
      previousActive: false,
    })).toBe(false);
  });

  it('does not activate for non-stepped or non-EV devices', () => {
    expect(resolveEvBoostActive({
      dev: buildPlanInputDevice({
        deviceClass: 'evcharger',
        evBoost: { enabled: true, boostBelowPercent: 40 },
        stateOfCharge: { percent: 20, status: 'fresh' },
      }),
      previousActive: false,
    })).toBe(false);
    expect(resolveEvBoostActive({
      dev: steppedInputDevice({
        evBoost: { enabled: true, boostBelowPercent: 40 },
        stateOfCharge: { percent: 20, status: 'fresh' },
      }),
      previousActive: false,
    })).toBe(false);
  });
});

describe('buildBoostPlanDeviceFields — boostActive aggregate', () => {
  const dev = buildPlanInputDevice({});

  it('is true when only temperature boost fires', () => {
    expect(buildBoostPlanDeviceFields({
      dev,
      temperatureBoostActive: true,
      evBoostActive: false,
    }).boostActive).toBe(true);
  });

  it('is true when only EV boost fires', () => {
    expect(buildBoostPlanDeviceFields({
      dev,
      temperatureBoostActive: false,
      evBoostActive: true,
    }).boostActive).toBe(true);
  });

  it('is true when both fire', () => {
    expect(buildBoostPlanDeviceFields({
      dev,
      temperatureBoostActive: true,
      evBoostActive: true,
    }).boostActive).toBe(true);
  });

  it('is false when neither fires', () => {
    expect(buildBoostPlanDeviceFields({
      dev,
      temperatureBoostActive: false,
      evBoostActive: false,
    }).boostActive).toBe(false);
  });
});
