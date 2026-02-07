import { buildPelsStatus } from '../lib/core/pelsStatus';
import type { DevicePlan } from '../lib/plan/planTypes';

describe('pels status limit reason', () => {
  it('reports hourly limit when a device is still shed in cooldown', () => {
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
          plannedState: 'shed',
          currentTarget: 21,
          plannedTarget: 15,
          reason: 'cooldown (shedding, 45s remaining)',
          controllable: true,
          shedAction: 'set_temperature',
          shedTemperature: 15,
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

    expect(status.limitReason).toBe('hourly');
  });

  it('reports daily limit when a device is still shed in cooldown', () => {
    const plan: DevicePlan = {
      meta: {
        totalKw: 4.2,
        softLimitKw: 6,
        softLimitSource: 'daily',
        headroomKw: 1.8,
      },
      devices: [
        {
          id: 'dev-1',
          name: 'Living Room Heater',
          currentState: 'on',
          plannedState: 'shed',
          currentTarget: 21,
          plannedTarget: 15,
          reason: 'cooldown (shedding, 45s remaining)',
          controllable: true,
          shedAction: 'set_temperature',
          shedTemperature: 15,
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

    expect(status.limitReason).toBe('daily');
  });
});
