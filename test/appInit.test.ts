import { createPlanService } from '../lib/app/appInit';

describe('app init plan service wiring', () => {
  it('derives binary control from legacy snapshot capabilities when controlCapabilityId is missing', () => {
    const service = createPlanService({
      homey: {
        settings: { get: jest.fn(), set: jest.fn() },
        flow: { getTriggerCard: jest.fn() },
      } as never,
      planEngine: {} as never,
      getCapacityDryRun: () => false,
      getLastPowerUpdate: () => null,
      getLatestTargetSnapshot: () => [
        {
          id: 'socket-1',
          name: 'Socket',
          capabilities: ['onoff'],
        },
        {
          id: 'ev-1',
          name: 'EV',
          capabilities: ['evcharger_charging', 'evcharger_charging_state'],
        },
        {
          id: 'temp-1',
          name: 'Thermostat',
          capabilities: ['measure_temperature', 'target_temperature'],
        },
      ],
      resolveManagedState: () => true,
      isCapacityControlEnabled: () => true,
      isBudgetExempt: () => false,
      isCurrentHourCheap: () => false,
      isCurrentHourExpensive: () => false,
      log: jest.fn(),
      logDebug: jest.fn(),
      error: jest.fn(),
    });

    const planDevices = (service as unknown as {
      deps: { getPlanDevices: () => Array<{ id: string; hasBinaryControl?: boolean }> };
    }).deps.getPlanDevices();

    expect(planDevices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'socket-1', hasBinaryControl: true }),
      expect.objectContaining({ id: 'ev-1', hasBinaryControl: true }),
      expect.objectContaining({ id: 'temp-1', hasBinaryControl: false }),
    ]));
  });
});
