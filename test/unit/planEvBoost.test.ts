import { normalizeEvBoostSettings } from '../../packages/contracts/src/evBoost';
import { buildBoostPlanDeviceFields, resolveEvBoostActive } from '../../lib/plan/planEvBoost';
import { buildPlanInputDevice, steppedInputDevice } from '../utils/planTestUtils';
import {
  type EvDiscriminantProbe,
  withEvDiscriminant,
} from '../../lib/plan/planTypes';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

// The EV cluster (`evBoost` / `stateOfCharge`) moved off `PlanInputDevice`'s base
// onto the orthogonal `EvKind` cluster, so the shared builders' params no longer
// accept those fields. Split the cluster off, build through the shared helper,
// then re-attach it via `withEvDiscriminant`. (`evChargingState` is observer-owned
// and forwarded through the shared builders' existing `evChargingState?` slot.)
const withEvCluster = (
  device: PlanInputDevice,
  cluster: EvDiscriminantProbe,
): PlanInputDevice => withEvDiscriminant({ ...device, ...cluster }) as PlanInputDevice;

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
  const buildEvDevice = (
    overrides: Parameters<typeof steppedInputDevice>[0] & EvDiscriminantProbe & { forceBoostActive?: boolean } = {},
  ): PlanInputDevice => {
    const { stateOfCharge, evBoost, evChargingState, ...rest } = overrides;
    // Preserve explicit-`undefined` overrides (`evBoost: undefined`,
    // `stateOfCharge: undefined`) rather than defaulting them via destructuring.
    const cluster: EvDiscriminantProbe = {
      stateOfCharge: 'stateOfCharge' in overrides ? stateOfCharge : { percent: 32, status: 'fresh' as const },
      evBoost: 'evBoost' in overrides ? evBoost : { enabled: true, boostBelowPercent: 40 },
    };
    return withEvCluster(
      steppedInputDevice({
        deviceClass: 'evcharger',
        deviceType: 'onoff',
        targets: [],
        evChargingState: evChargingState ?? 'plugged_in_charging',
        ...rest,
      }),
      cluster,
    );
  };

  it('activates for stepped EV chargers below the threshold with fresh SoC', () => {
    expect(resolveEvBoostActive(buildEvDevice())).toBe(true);
  });

  it('forces boost on for the deferred limit-lower-priority lane, ignoring config/threshold', () => {
    // No evBoost config and SoC above any threshold: only the admission-set forceBoostActive
    // flag activates it (the limit-lower-priority lane).
    const dev = buildEvDevice({
      forceBoostActive: true,
      evBoost: undefined,
      stateOfCharge: { percent: 90, status: 'fresh' as const },
    });
    expect(resolveEvBoostActive(dev)).toBe(true);
  });

  it('stops at the target threshold without hysteresis', () => {
    const dev = buildEvDevice({ stateOfCharge: { percent: 40, status: 'fresh' as const } });
    expect(resolveEvBoostActive(dev)).toBe(false);
  });

  it('does not activate for stale, missing, or unplugged EV state', () => {
    expect(resolveEvBoostActive(buildEvDevice({
      stateOfCharge: { percent: 20, status: 'stale' as const },
    }))).toBe(false);
    expect(resolveEvBoostActive(buildEvDevice({ stateOfCharge: undefined }))).toBe(false);
    expect(resolveEvBoostActive(buildEvDevice({ evChargingState: 'plugged_out' }))).toBe(false);
  });

  it('does not activate for a connected-but-not-resumable charger (plugged_in)', () => {
    // `plugged_in` (distinct from the resumable `plugged_in_paused`) cannot be
    // driven by PELS, so boost must never claim to activate — even with a fresh
    // SoC below the threshold.
    expect(resolveEvBoostActive(buildEvDevice({
      evChargingState: 'plugged_in',
      stateOfCharge: { percent: 20, status: 'fresh' as const },
    }))).toBe(false);
  });

  it('does not activate for non-stepped or non-EV devices', () => {
    expect(resolveEvBoostActive(withEvCluster(
      buildPlanInputDevice({ deviceClass: 'evcharger' }),
      {
        evBoost: { enabled: true, boostBelowPercent: 40 },
        stateOfCharge: { percent: 20, status: 'fresh' },
      },
    ))).toBe(false);
    expect(resolveEvBoostActive(withEvCluster(
      steppedInputDevice({}),
      {
        evBoost: { enabled: true, boostBelowPercent: 40 },
        stateOfCharge: { percent: 20, status: 'fresh' },
      },
    ))).toBe(false);
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
