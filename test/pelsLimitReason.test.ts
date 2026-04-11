import { buildPelsStatus } from '../lib/core/pelsStatus';
import type { DevicePlan } from '../lib/plan/planTypes';

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
    reason: string;
    headroomKw?: number;
  }): DevicePlan => ({
    meta: {
      totalKw: 4.2,
      softLimitKw: 6,
      softLimitSource: params.softLimitSource,
      headroomKw: params.headroomKw ?? 1.8,
    },
    devices: [
      {
        ...baseDevice,
        reason: params.reason,
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
      combinedPrices: { prices: [{ total: 1.2 }] },
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.limitReason).toBe(expected);
  });

  it.each([
    ['capacity', 'cooldown (restore, 45s remaining)'],
    ['capacity', 'restore throttled'],
    ['daily', 'cooldown (restore, 45s remaining)'],
    ['daily', 'restore throttled'],
  ] as const)('reports none for %s source when shed reason is "%s"', (softLimitSource, reason) => {
    const plan = buildPlan({
      softLimitSource,
      reason,
    });

    const { status } = buildPelsStatus({
      plan,
      isCheap: false,
      isExpensive: false,
      combinedPrices: { prices: [{ total: 1.2 }] },
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.limitReason).toBe('none');
  });

  it('reports none for active devices showing headroom cooldown status', () => {
    const plan: DevicePlan = {
      meta: {
        totalKw: 4.2,
        softLimitKw: 6,
        softLimitSource: 'capacity',
        headroomKw: 1.8,
      },
      devices: [
        {
          id: 'dev-1',
          name: 'Living Room Heater',
          currentState: 'on',
          plannedState: 'keep',
          currentTarget: 21,
          plannedTarget: 21,
          controllable: true,
          reason: 'headroom cooldown (45s remaining; usage 6.00 -> 3.50kW)',
        },
      ],
    };

    const { status } = buildPelsStatus({
      plan,
      isCheap: false,
      isExpensive: false,
      combinedPrices: { prices: [{ total: 1.2 }] },
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
          plannedTarget: null,
          controllable: true,
          reason: 'inactive (charger is unplugged)',
        },
      ],
    };

    const { status } = buildPelsStatus({
      plan,
      isCheap: false,
      isExpensive: false,
      combinedPrices: { prices: [{ total: 1.2 }] },
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
        shortfallThresholdKw: 6,
        hardCapHeadroomKw: -1.2,
      },
      devices: [],
    };

    const { status } = buildPelsStatus({
      plan,
      isCheap: false,
      isExpensive: false,
      combinedPrices: { prices: [{ total: 1.2 }] },
      lastPowerUpdate: Date.UTC(2026, 1, 7, 12, 0, 0),
    });

    expect(status.capacityShortfall).toBe(true);
    expect(status.shortfallThresholdKw).toBe(6);
    expect(status.hardCapHeadroomKw).toBe(-1.2);
  });
});
