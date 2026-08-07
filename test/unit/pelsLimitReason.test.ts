import { buildPelsStatus } from '../../lib/plan/pelsStatus';
import { PriceLevel } from '../../lib/price/priceLevels';
import { NEUTRAL_STARTUP_HOLD_REASON } from '../../lib/plan/restore/devices';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { withTemperatureDiscriminant } from '../../lib/plan/planTypes';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';

describe('pels status limit reason', () => {
  const baseDevice = {
    commandableNow: true,
    id: 'dev-1',
    name: 'Living Room Heater',
    currentState: 'on',
    plannedState: 'shed',
    currentTarget: 21,
    plannedTarget: 15,
    controllable: true,
    shedAction: 'set_temperature',
    shedTemperature: 15,
  } as const;

  const buildPlan = (params: {
    softLimitSource: 'capacity' | 'daily' | 'both';
    reason: string | DeviceReason;
    headroomKw?: number;
    powerKnown?: boolean;
  }): DevicePlan => ({
    meta: {
      totalKw: 4.2,
      softLimitKw: 6,
      softLimitSource: params.softLimitSource,
      headroomKw: params.headroomKw ?? 1.8,
      powerKnown: params.powerKnown ?? true,
    },
    devices: [
      {
        ...baseDevice,
        reason: typeof params.reason === 'string' ? fixtureDeviceReason(params.reason)! : params.reason,
      },
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

    const { status } = buildPelsStatus({
      plan,
      isCheap: false,
      isExpensive: false,
      combinedPrices: { version: 2, days: { '2026-05-10': { hours: [{ startsAt: '2026-05-10T00:00:00.000Z', total: 1.2, isCheap: false, isExpensive: false }] } } },
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

    const { status } = buildPelsStatus({
      plan,
      isCheap: false,
      isExpensive: false,
      combinedPrices: { version: 2, days: { '2026-05-10': { hours: [{ startsAt: '2026-05-10T00:00:00.000Z', total: 1.2, isCheap: false, isExpensive: false }] } } },
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
      powerKnown: false,
    });

    const { status } = buildPelsStatus({
      plan,
      isCheap: false,
      isExpensive: false,
      combinedPrices: { version: 2, days: { '2026-05-10': { hours: [{ startsAt: '2026-05-10T00:00:00.000Z', total: 1.2, isCheap: false, isExpensive: false }] } } },
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.limitReason).toBe('none');
  });

  it('does not count inactive EV devices as shed or active', () => {
    const plan: DevicePlan = {
      meta: {
        totalKw: 0.4,
        softLimitKw: 6,
        softLimitSource: 'capacity',
        headroomKw: 5.6,
      },
      devices: [
        withTemperatureDiscriminant({
          id: 'ev-1',
          name: 'EV Charger',
          commandableNow: true,
          currentState: 'off',
          plannedState: 'inactive' as const,
          currentTarget: null,
          controllable: true,
          reason: fixtureDeviceReason('inactive (charger is unplugged)')!,
        }),
      ],
    };

    const { status } = buildPelsStatus({
      plan,
      isCheap: false,
      isExpensive: false,
      combinedPrices: { version: 2, days: { '2026-05-10': { hours: [{ startsAt: '2026-05-10T00:00:00.000Z', total: 1.2, isCheap: false, isExpensive: false }] } } },
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.limitReason).toBe('none');
    expect(status.devicesOn).toBe(0);
    expect(status.devicesOff).toBe(0);
  });

  it('copies hard-cap shortfall fields into status', () => {
    const plan: DevicePlan = {
      meta: {
        totalKw: 7.2,
        softLimitKw: 4.8,
        softLimitSource: 'capacity',
        headroomKw: -2.4,
        capacityShortfall: true,
        shortfallBudgetThresholdKw: 6,
        shortfallBudgetHeadroomKw: -1.2,
        hardCapHeadroomKw: -1.2,
      },
      devices: [],
    };

    const { status } = buildPelsStatus({
      plan,
      isCheap: false,
      isExpensive: false,
      combinedPrices: { version: 2, days: { '2026-05-10': { hours: [{ startsAt: '2026-05-10T00:00:00.000Z', total: 1.2, isCheap: false, isExpensive: false }] } } },
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.capacityShortfall).toBe(true);
    expect(status.shortfallBudgetThresholdKw).toBe(6);
    expect(status.shortfallBudgetHeadroomKw).toBe(-1.2);
    expect(status.hardCapHeadroomKw).toBe(-1.2);
  });

  // Regression for #646 review: combined_prices is V2 (date-keyed `days`), not
  // a flat `prices[]` array. Without V2 awareness in `hasPrices`, the price
  // level would resolve to UNKNOWN and the price_level_changed flow trigger
  // would fire spuriously.
  it.each([
    [{ isCheap: true, isExpensive: false }, PriceLevel.CHEAP],
    [{ isCheap: false, isExpensive: true }, PriceLevel.EXPENSIVE],
    [{ isCheap: false, isExpensive: false }, PriceLevel.NORMAL],
  ] as const)('resolves price level from V2 combined_prices payload', (flags, expected) => {
    const plan = buildPlan({ softLimitSource: 'capacity', reason: 'keep' });
    const { status } = buildPelsStatus({
      plan,
      isCheap: flags.isCheap,
      isExpensive: flags.isExpensive,
      combinedPrices: { version: 2, days: { '2026-05-10': { hours: [
        { startsAt: '2026-05-10T00:00:00.000Z', total: 1.2, isCheap: false, isExpensive: false },
      ] } } },
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });
    expect(status.priceLevel).toBe(expected);
  });

  it('resolves price level to UNKNOWN when V2 store has no hours', () => {
    const plan = buildPlan({ softLimitSource: 'capacity', reason: 'keep' });
    const { status } = buildPelsStatus({
      plan,
      isCheap: true,
      isExpensive: false,
      combinedPrices: { version: 2, days: {} },
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });
    expect(status.priceLevel).toBe(PriceLevel.UNKNOWN);
  });
});

describe('pels status projected-over-hard-cap flag', () => {
  const buildPlanWithMeta = (meta: DevicePlan['meta']): DevicePlan => ({
    meta,
    devices: [],
  });

  const statusFor = (meta: DevicePlan['meta']) => buildPelsStatus({
    plan: buildPlanWithMeta(meta),
    isCheap: false,
    isExpensive: false,
    combinedPrices: null,
    lastPowerUpdate: Date.UTC(2026, 6, 5, 12, 0, 0),
  }).status;

  it('flags the trajectory when projected hour energy lands past the cap', () => {
    // projected = 1.9 + 6.0 × 28/60 = 4.7 kWh > 4.5 kWh cap.
    const status = statusFor({
      totalKw: 6.0,
      softLimitKw: 5.5,
      headroomKw: -0.5,
      usedKWh: 1.9,
      minutesRemaining: 28,
      hardCapLimitKw: 4.5,
      powerKnown: true,
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
      powerKnown: true,
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
      powerKnown: true,
    });
    expect(status.projectedOverHardCap).toBe(false);
  });

  it('stays false when projection inputs are missing', () => {
    const status = statusFor({
      totalKw: 5.2,
      softLimitKw: 5.5,
      headroomKw: 0.3,
      powerKnown: true,
    });
    expect(status.projectedOverHardCap).toBe(false);
  });
});

describe('pels status effective dry-run posture (R7b, per-home Limits card)', () => {
  const emptyPlan: DevicePlan = {
    meta: { totalKw: 0, softLimitKw: 6, headroomKw: 1, powerKnown: true },
    devices: [],
  };
  const statusWith = (dryRunEffective?: boolean) => buildPelsStatus({
    plan: emptyPlan,
    isCheap: false,
    isExpensive: false,
    combinedPrices: null,
    lastPowerUpdate: null,
    dryRunEffective,
  }).status;

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
    meta: { totalKw: 5.2, softLimitKw: 6, headroomKw: 0.8, powerKnown: true },
    devices: [],
  };
  const statusWith = (dryRunEffective?: boolean) => buildPelsStatus({
    plan: drawPlan,
    isCheap: false,
    isExpensive: false,
    combinedPrices: null,
    lastPowerUpdate: null,
    dryRunEffective,
  }).status;

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
