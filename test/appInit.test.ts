import { createPlanService } from '../lib/app/appInit';
import type { AppContext } from '../lib/app/appContext';

describe('app init plan service wiring', () => {
  it('derives binary control from legacy snapshot capabilities when controlCapabilityId is missing', () => {
    const service = createPlanService({
      homey: {
        settings: { get: vi.fn(), set: vi.fn() },
        flow: { getTriggerCard: vi.fn() },
      } as never,
      planEngine: {} as never,
      get capacityDryRun() { return false; },
      get powerTracker() { return {} as never; },
      get latestTargetSnapshot() { return [
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
      ] as any; },
      resolveManagedState: () => true,
      isCapacityControlEnabled: () => true,
      isBudgetExempt: () => false,
      debugLoggingTopics: new Set(),
      snapshotHelpers: { schedulePostActuationRefresh: vi.fn() } as any,
      priceCoordinator: {
        isCurrentHourCheap: () => false,
        isCurrentHourExpensive: () => false,
      } as any,
      getStructuredLogger: () => undefined,
      getStructuredDebugEmitter: () => vi.fn() as any,
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    } as unknown as AppContext);

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
