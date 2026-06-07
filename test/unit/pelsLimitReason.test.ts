import { buildPelsStatus } from '../../lib/plan/pelsStatus';
import { PriceLevel } from '../../lib/price/priceLevels';
import { NEUTRAL_STARTUP_HOLD_REASON } from '../../lib/plan/restore/devices';
import type { DevicePlan } from '../../lib/plan/planTypes';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { legacyDeviceReason } from '../utils/deviceReasonTestUtils';

describe('pels status limit reason', () => {
  const baseDevice = {
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
        reason: typeof params.reason === 'string' ? legacyDeviceReason(params.reason) : params.reason,
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

    expect(status.limitReason).toBe('none');
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
        {
          id: 'ev-1',
          name: 'EV Charger',
          currentState: 'off',
          plannedState: 'inactive',
          currentTarget: null,
          controllable: true,
          reason: legacyDeviceReason('inactive (charger is unplugged)'),
        },
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
    const plan = buildPlan({ softLimitSource: 'capacity', reason: 'normal' });
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
    const plan = buildPlan({ softLimitSource: 'capacity', reason: 'normal' });
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
