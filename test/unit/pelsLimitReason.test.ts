import { buildPelsStatus } from '../../lib/plan/pelsStatus';
import { PriceLevel } from '../../lib/price/priceLevels';
import { NEUTRAL_STARTUP_HOLD_REASON } from '../../lib/plan/restore/devices';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { withTemperatureDiscriminant } from '../../lib/plan/planTypes';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import { buildPlanMeta, withFixtureResidualKw } from '../utils/planTestUtils';

describe('pels status limit reason', () => {
  const baseDevice = {
    commandableNow: true,
    boostSupported: false,
    boostRequested: false,
    hasStandingDemand: true,
    surplusTracking: false,
    confirmedNotDrawing: false,
    id: 'dev-1',
    name: 'Living Room Heater',
    currentState: 'on',
    plannedState: 'shed',
    boostActive: false,
    currentTarget: 21,
    currentTemperature: 21,
    plannedTarget: 15,
    controllable: true,
    available: true,
    shedAction: 'set_temperature',
    shedTemperature: 15,
  } as const;

  const buildPlan = (params: {
    softLimitSource: 'capacity' | 'daily';
    reason: string | DeviceReason;
    headroomKw?: number;
    /** The producer-resolved measured draw; `null` means this cycle had none. */
    powerNowKw?: number | null;
  }): DevicePlan => ({
    meta: buildPlanMeta({
      totalKw: 4.2,
      softLimitKw: 6,
      softLimitSource: params.softLimitSource,
      headroomKw: params.headroomKw ?? 1.8,
      powerNowKw: params.powerNowKw === undefined ? 4.2 : params.powerNowKw}),
    devices: [
      withFixtureResidualKw({ expectedPowerKw: 1, expectedPowerSource: 'default', currentDrawKw: 0,
        recordRestoreOnTargetApply: false,
        ...baseDevice,
        reason: typeof params.reason === 'string' ? fixtureDeviceReason(params.reason)! : params.reason,
      }),
    ],
  });

  it.each([
    ['capacity', 'hourly'],
    ['daily', 'daily'],
  ] as const)('reports %s limit when a device is still shed in cooldown', (softLimitSource, expected) => {
    const plan = buildPlan({
      softLimitSource,
      reason: 'cooldown (shedding, 45s remaining)',
    });

    const status = buildPelsStatus({
      plan,
      priceLevel: PriceLevel.NORMAL,
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.limitReason).toBe(expected);
  });

  it.each([
    ['capacity', 'meter settling (45s remaining)'],
    ['capacity', 'cooldown (restore, 45s remaining)'],
    ['capacity', 'restore throttled'],
    ['capacity', NEUTRAL_STARTUP_HOLD_REASON],
    ['daily', 'meter settling (45s remaining)'],
    ['daily', 'cooldown (restore, 45s remaining)'],
    ['daily', 'restore throttled'],
    ['daily', NEUTRAL_STARTUP_HOLD_REASON],
  ] as const)('reports none for %s source when shed reason is "%s"', (softLimitSource, reason) => {
    const plan = buildPlan({
      softLimitSource,
      reason,
    });

    const status = buildPelsStatus({
      plan,
      priceLevel: PriceLevel.NORMAL,
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    // The held device still counts in devicesOff even though the reason is a
    // transient restore/settling hold, not the cap — this is exactly the pair
    // (devicesOff>0 + limitReason 'none') the per-home status copy must not
    // attribute to the cap (see homeLimitsStatus composeHomeLimitsStateLine).
    expect(status.limitReason).toBe('none');
    expect(status.devicesOff).toBe(1);
  });

  it('reports none for synthetic fail-closed headroom without known power', () => {
    const plan = buildPlan({
      softLimitSource: 'capacity',
      reason: 'keep',
      headroomKw: -1,
      // No measurement this cycle, so the -1 is the fail-closed SENTINEL, not a
      // real negative headroom — the status must not read it as a limit.
      powerNowKw: null,
    });

    const status = buildPelsStatus({
      plan,
      priceLevel: PriceLevel.NORMAL,
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.limitReason).toBe('none');
  });

  it('does not count inactive EV devices as shed or active', () => {
    const plan: DevicePlan = {
      meta: buildPlanMeta({
        totalKw: 0.4,
        softLimitKw: 6,
        softLimitSource: 'capacity',
        headroomKw: 5.6}),
      devices: [
        withTemperatureDiscriminant(withFixtureResidualKw({ expectedPowerKw: 1, expectedPowerSource: 'default' as const, currentDrawKw: 0,
          recordRestoreOnTargetApply: false,
          id: 'ev-1',
          name: 'EV Charger',
          commandableNow: true,
          boostSupported: false,
          boostRequested: false,
          hasStandingDemand: true,
          surplusTracking: false,
          confirmedNotDrawing: false,
          currentState: 'off',
          plannedState: 'inactive' as const,
          boostActive: false,
          controllable: true,
          available: true,
          reason: fixtureDeviceReason('inactive (charger is unplugged)')!,
        })),
      ],
    };

    const status = buildPelsStatus({
      plan,
      priceLevel: PriceLevel.NORMAL,
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.limitReason).toBe('none');
    expect(status.devicesOn).toBe(0);
    expect(status.devicesOff).toBe(0);
  });

  it('copies hard-cap shortfall fields into status', () => {
    const plan: DevicePlan = {
      meta: buildPlanMeta({
        totalKw: 7.2,
        softLimitKw: 4.8,
        softLimitSource: 'capacity',
        headroomKw: -2.4,
        capacityShortfall: true,
        shortfallBudgetThresholdKw: 6,
        shortfallBudgetHeadroomKw: -1.2,
        hardCapHeadroomKw: -1.2}),
      devices: [],
    };

    const status = buildPelsStatus({
      plan,
      priceLevel: PriceLevel.NORMAL,
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.capacityShortfall).toBe(true);
    expect(status.shortfallBudgetThresholdKw).toBe(6);
    expect(status.shortfallBudgetHeadroomKw).toBe(-1.2);
    expect(status.hardCapHeadroomKw).toBe(-1.2);
  });

  // The status carries the level the PRICE SERVICE resolved; it no longer
  // re-derives one from the two raw flags plus a shape check of the combined
  // price blob (the #646 regression this used to pin — a V2 payload the check
  // did not understand collapsed the level to UNKNOWN and fired
  // `price_level_changed` spuriously — is gone with that check). Whether the
  // producer answers UNKNOWN is pinned at the producer, in
  // `test/integration/priceLevelSingleSeriesBuild.test.ts`.
  it.each([
    PriceLevel.CHEAP,
    PriceLevel.EXPENSIVE,
    PriceLevel.NORMAL,
    PriceLevel.UNKNOWN,
  ] as const)('carries the producer-resolved price level through to the status', (priceLevel) => {
    const plan = buildPlan({ softLimitSource: 'capacity', reason: 'keep' });
    const status = buildPelsStatus({
      plan,
      priceLevel,
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });
    expect(status.priceLevel).toBe(priceLevel);
  });
});

describe('pels status projected-over-hard-cap flag', () => {
  const buildPlanWithMeta = (meta: DevicePlan['meta']): DevicePlan => ({
    meta,
    devices: [],
  });

  // Takes a PARTIAL meta and completes it via the shared fixture: the plan meta
  // is required almost throughout now, and each case here is about two or three
  // numbers, not about spelling a full meta.
  const statusFor = (meta: Partial<DevicePlan['meta']>) => buildPelsStatus({
    plan: buildPlanWithMeta(buildPlanMeta(meta)),
    priceLevel: PriceLevel.NORMAL,
    lastPowerUpdate: Date.UTC(2026, 6, 5, 12, 0, 0),
  });

  it('flags the trajectory when projected hour energy lands past the cap', () => {
    // projected = 1.9 + 6.0 × 28/60 = 4.7 kWh > 4.5 kWh cap.
    const status = statusFor({
      totalKw: 6.0,
      softLimitKw: 5.5,
      headroomKw: -0.5,
      usedKWh: 1.9,
      minutesRemaining: 28,
      hardCapLimitKw: 4.5,
    });
    expect(status.projectedOverHardCap).toBe(true);
  });

  it('stays false when instantaneous power is above the cap but the hour is on track', () => {
    // Regression (owner report 2026-07-05): draw 5.2 kW > cap 5.0 kW, but
    // projected = 1.9 + 5.2 × 28/60 ≈ 4.33 kWh < 5.0 kWh — the cap is an
    // hourly-average ceiling, so this is not a breach.
    const status = statusFor({
      totalKw: 5.2,
      softLimitKw: 5.5,
      headroomKw: 0.3,
      usedKWh: 1.9,
      minutesRemaining: 28,
      hardCapLimitKw: 5.0,
    });
    expect(status.projectedOverHardCap).toBe(false);
  });

  it('holds the step when the projection lands exactly at the cap (strict >)', () => {
    // 1.9 + 5.2 × 30/60 = 4.5 kWh == cap → not over.
    const status = statusFor({
      totalKw: 5.2,
      softLimitKw: 5.5,
      headroomKw: 0.3,
      usedKWh: 1.9,
      minutesRemaining: 30,
      hardCapLimitKw: 4.5,
    });
    expect(status.projectedOverHardCap).toBe(false);
  });

  it('stays false when projection inputs are missing', () => {
    const status = statusFor({
      totalKw: 5.2,
      softLimitKw: 5.5,
      headroomKw: 0.3,
    });
    expect(status.projectedOverHardCap).toBe(false);
  });
});

describe('pels status effective dry-run posture (R7b, per-home Limits card)', () => {
  const emptyPlan: DevicePlan = {
    meta: buildPlanMeta({ totalKw: 0, softLimitKw: 6, headroomKw: 1, powerNowKw: 0}),
    devices: [],
  };
  const statusWith = (dryRunEffective?: boolean) => buildPelsStatus({
    plan: emptyPlan,
    priceLevel: PriceLevel.NORMAL,
    lastPowerUpdate: null,
    dryRunEffective,
  });

  it('emits the effective dry-run when a sub-home bundle supplies it', () => {
    expect(statusWith(true).dryRunEffective).toBe(true);
    expect(statusWith(false).dryRunEffective).toBe(false);
  });

  it('omits the field for the main home (undefined ⇒ JSON-dropped ⇒ byte-identical blob)', () => {
    const status = statusWith(undefined);
    expect(status.dryRunEffective).toBeUndefined();
    // The persisted blob must not gain a key for the main home.
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(status)), 'dryRunEffective')).toBe(false);
  });
});

describe('pels status whole-area total (per-home Limits "Power now")', () => {
  const drawPlan: DevicePlan = {
    meta: buildPlanMeta({ totalKw: 5.2, softLimitKw: 6, headroomKw: 0.8, powerNowKw: 5.2}),
    devices: [],
  };
  const statusWith = (dryRunEffective?: boolean) => buildPelsStatus({
    plan: drawPlan,
    priceLevel: PriceLevel.NORMAL,
    lastPowerUpdate: null,
    dryRunEffective,
  });

  it('emits the meter total for a sub-home so the card renders Power now without per-device attribution', () => {
    expect(statusWith(true).totalKw).toBe(5.2);
    expect(statusWith(false).totalKw).toBe(5.2);
  });

  it('omits the total for the main home (undefined dry-run ⇒ JSON-dropped ⇒ byte-identical blob)', () => {
    const status = statusWith(undefined);
    expect(status.totalKw).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(status)), 'totalKw')).toBe(false);
  });
});
