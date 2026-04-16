const {
  capturedPlanEngineDeps,
  capturedPriceCoordinatorDeps,
  capturedFlowCardDeps,
} = vi.hoisted(() => ({
  capturedPlanEngineDeps: { current: null as null | Record<string, unknown> },
  capturedPriceCoordinatorDeps: { current: null as null | Record<string, unknown> },
  capturedFlowCardDeps: { current: null as null | Record<string, unknown> },
}));

vi.mock('../lib/plan/planEngine', () => ({
  PlanEngine: class MockPlanEngine {
    deps: Record<string, unknown>;

    constructor(deps: Record<string, unknown>) {
      this.deps = deps;
      capturedPlanEngineDeps.current = deps;
    }
  },
}));

vi.mock('../lib/price/priceCoordinator', () => ({
  PriceCoordinator: class MockPriceCoordinator {
    deps: Record<string, unknown>;

    constructor(deps: Record<string, unknown>) {
      this.deps = deps;
      capturedPriceCoordinatorDeps.current = deps;
    }
  },
}));

vi.mock('../flowCards/registerFlowCards', () => ({
  registerFlowCards: (deps: Record<string, unknown>) => {
    capturedFlowCardDeps.current = deps;
  },
}));

import {
  createPlanEngine,
  createPlanService,
  createPriceCoordinator,
  registerAppFlowCards,
} from '../lib/app/appInit';
import type { AppContext } from '../lib/app/appContext';
import { createAppContextMock } from './helpers/appContextTestHelpers';

describe('app init plan service wiring', () => {
  it('fails fast when device manager wiring is missing', () => {
    const ctx = createAppContextMock({
      deviceManager: undefined,
    });

    expect(() => createPlanEngine(ctx)).toThrow(
      'DeviceManager must be initialized before plan engine setup.',
    );
  });

  it('routes plan engine debug logging through the fixed plan topic', () => {
    const logDebug = vi.fn();
    capturedPlanEngineDeps.current = null;
    const engine = createPlanEngine(createAppContextMock({
      deviceManager: {} as AppContext['deviceManager'],
      logDebug,
    }));

    expect(engine).toBeDefined();
    (capturedPlanEngineDeps.current as { logDebug: (...args: unknown[]) => void }).logDebug('debug payload', 123);

    expect(logDebug).toHaveBeenCalledWith('plan', 'debug payload', 123);
  });

  it('derives binary control from legacy snapshot capabilities when controlCapabilityId is missing', () => {
    const service = createPlanService(createAppContextMock({
      planEngine: {} as AppContext['planEngine'],
      latestTargetSnapshot: [
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
      debugLoggingTopics: new Set(),
      getStructuredDebugEmitter: () => vi.fn(),
    }));

    const planDevices = (service as unknown as {
      deps: { getPlanDevices: () => Array<{ id: string; hasBinaryControl?: boolean }> };
    }).deps.getPlanDevices();

    expect(planDevices).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'socket-1', hasBinaryControl: true }),
      expect.objectContaining({ id: 'ev-1', hasBinaryControl: true }),
      expect.objectContaining({ id: 'temp-1', hasBinaryControl: false }),
    ]));
  });

  it('fails fast when plan engine wiring is missing', () => {
    const ctx = createAppContextMock({
      planEngine: undefined,
      resolveManagedState: () => true,
      isCapacityControlEnabled: () => true,
      isBudgetExempt: () => false,
      debugLoggingTopics: new Set(),
      getStructuredDebugEmitter: () => vi.fn(),
    });

    expect(() => createPlanService(ctx)).toThrow(
      'PlanEngine must be initialized before plan service setup.',
    );
  });

  it('fails fast when daily budget wiring is missing for flow card registration', () => {
    capturedFlowCardDeps.current = null;
    const ctx = createAppContextMock({
      dailyBudgetService: undefined,
    });

    registerAppFlowCards(ctx);

    expect(
      () => (capturedFlowCardDeps.current as { loadDailyBudgetSettings: () => void }).loadDailyBudgetSettings(),
    ).toThrow(
      'DailyBudgetService must be initialized before flow card registration.',
    );
  });

  it('fails fast when price coordinator rebuild wiring is invoked without a plan service', async () => {
    capturedPriceCoordinatorDeps.current = null;
    createPriceCoordinator(createAppContextMock({
      planService: undefined,
    }));

    expect(
      () => (capturedPriceCoordinatorDeps.current as { rebuildPlanFromCache: (reason?: string) => Promise<void> })
        .rebuildPlanFromCache('price_refresh'),
    ).toThrow('PlanService must be initialized before price coordinator wiring.');
  });
});
