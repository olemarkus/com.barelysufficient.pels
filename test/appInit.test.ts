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
  createDeferredObjectivePlanHistoryRecorder,
  createPlanEngine,
  createPlanService,
  createPriceCoordinator,
  persistDeferredObjectiveObservationWatermark,
  registerAppFlowCards,
} from '../lib/app/appInit';
import { DeferredObjectivePlanHistoryRecorder } from '../lib/plan/deferredObjectives';
import { DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK } from '../lib/utils/settingsKeys';
import type { AppContext } from '../lib/app/appContext';
import { createAppContextMock } from './helpers/appContextTestHelpers';

describe('app init plan service wiring', () => {
  it('fails fast when device manager wiring is missing', () => {
    const ctx = createAppContextMock({
      deviceManager: undefined,
    });

    expect(() => createPlanEngine(ctx)).toThrow(
      'DeviceTransport must be initialized before plan engine setup.',
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

  it('disableDeferredObjective also forgets the status bus and active plan for the device', () => {
    // Regression: previously the auto-disable hook only wrote enabled=false to
    // settings, leaving the last published status snapshot live in the bus
    // until the next plan cycle's forget-sweep. Flow conditions like
    // deadline_status_is would still match the stale snapshot in that window.
    capturedPlanEngineDeps.current = null;
    const settingsStore = new Map<string, unknown>();
    settingsStore.set('deferred_objectives', {
      version: 1,
      objectivesByDeviceId: {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 55,
          deadlineAtMs: Date.now() + 60_000,
        },
      },
    });
    const forgetDevice = vi.fn();
    const clearForDevice = vi.fn();
    const homey = {
      flow: {
        getTriggerCard: vi.fn(),
        getConditionCard: vi.fn(),
        getActionCard: vi.fn(),
      },
      settings: {
        get: vi.fn((key: string) => settingsStore.get(key)),
        set: vi.fn((key: string, value: unknown) => { settingsStore.set(key, value); }),
        on: vi.fn(),
        off: vi.fn(),
      },
    } as unknown as AppContext['homey'];

    createPlanEngine(createAppContextMock({
      homey,
      deviceManager: {} as AppContext['deviceManager'],
      deferredObjectiveStatusBus: { forgetDevice } as unknown as AppContext['deferredObjectiveStatusBus'],
      deferredObjectiveActivePlanRecorder: {
        clearForDevice,
      } as unknown as AppContext['deferredObjectiveActivePlanRecorder'],
    }));

    const disable = (capturedPlanEngineDeps.current as {
      disableDeferredObjective: (deviceId: string) => void;
    }).disableDeferredObjective;
    disable('heater-1');

    const stored = settingsStore.get('deferred_objectives') as {
      objectivesByDeviceId: Record<string, { enabled: boolean }>;
    };
    expect(stored.objectivesByDeviceId['heater-1']?.enabled).toBe(false);
    expect(forgetDevice).toHaveBeenCalledWith('heater-1');
    expect(clearForDevice).toHaveBeenCalledWith('heater-1');
  });

  it('seeds the deferred-objective observation watermark on first install', () => {
    // First boot: settings.get returns undefined for everything. The recorder must seed the
    // watermark to "now" so a future restart can back-fill cleanly from this point forward.
    const ctx = createAppContextMock();
    const setSpy = ctx.homey.settings.set as unknown as ReturnType<typeof vi.fn>;
    setSpy.mockClear();

    createDeferredObjectivePlanHistoryRecorder(ctx);

    const watermarkCalls = setSpy.mock.calls.filter(
      ([key]) => key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
    );
    expect(watermarkCalls).toHaveLength(1);
    expect(typeof watermarkCalls[0]![1]).toBe('number');
    expect(watermarkCalls[0]![1] as number).toBeGreaterThan(0);
  });

  it('advances the watermark to now after a successful startup back-fill scan', () => {
    // Watermark exists but the scan window contains no enabled objectives — the watermark
    // should still advance so the next restart doesn't redundantly re-scan the same window.
    const ctx = createAppContextMock();
    const getSpy = ctx.homey.settings.get as unknown as ReturnType<typeof vi.fn>;
    const setSpy = ctx.homey.settings.set as unknown as ReturnType<typeof vi.fn>;
    const oldWatermark = Date.now() - 24 * 60 * 60 * 1000;
    getSpy.mockImplementation((key: string) => (
      key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK ? oldWatermark : undefined
    ));
    setSpy.mockClear();

    createDeferredObjectivePlanHistoryRecorder(ctx);

    const watermarkSets = setSpy.mock.calls.filter(
      ([key]) => key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
    );
    expect(watermarkSets).toHaveLength(1);
    expect((watermarkSets[0]![1] as number)).toBeGreaterThan(oldWatermark);
  });

  it('persistDeferredObjectiveObservationWatermark skips the write when the recorder is still dirty', () => {
    // Models the onUninit failure path: flushIfDirty was called, save returned false, the
    // recorder stayed dirty. Advancing the watermark in this state would cause next startup's
    // back-fill to skip the window containing the entries that were never persisted.
    const ctx = createAppContextMock();
    const setSpy = ctx.homey.settings.set as unknown as ReturnType<typeof vi.fn>;
    setSpy.mockClear();
    const recorder = new DeferredObjectivePlanHistoryRecorder({
      load: () => null,
      save: () => false,
    });
    // Drive the recorder into a dirty-and-couldn't-flush state.
    recorder.observe([{
      deviceId: 'dev',
      deviceName: 'Connected 300',
      objectiveId: 'dev:temperature',
      objectiveKind: 'temperature',
      enforcement: 'soft',
      status: 'on_track',
      reasonCode: 'planned_with_margin',
      targetPercent: null,
      currentPercent: null,
      targetTemperatureC: 65,
      currentTemperatureC: 50,
      deadlineAtMs: 6 * 60 * 60 * 1000,
      deadlineLocalTime: '06:00',
      energyNeededKWh: 1,
      kWhPerPercent: null,
      kWhPerDegreeC: 1,
      rateConfidence: 'high',
      horizonBucketCount: 6,
      requestedMinimumStepId: null,
    }], 0);
    recorder.observe([], 6 * 60 * 60 * 1000); // deadline-passed → finalized → dirty
    expect(recorder.flushIfDirty()).toBe(false);
    expect(recorder.isDirty()).toBe(true);

    persistDeferredObjectiveObservationWatermark(ctx, recorder);

    const watermarkSets = setSpy.mock.calls.filter(
      ([key]) => key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
    );
    expect(watermarkSets).toHaveLength(0);
  });

  it('persistDeferredObjectiveObservationWatermark writes when the recorder is clean', () => {
    const ctx = createAppContextMock();
    const setSpy = ctx.homey.settings.set as unknown as ReturnType<typeof vi.fn>;
    setSpy.mockClear();
    const recorder = new DeferredObjectivePlanHistoryRecorder({
      load: () => null,
      save: () => true,
    });
    expect(recorder.isDirty()).toBe(false);

    persistDeferredObjectiveObservationWatermark(ctx, recorder);

    const watermarkSets = setSpy.mock.calls.filter(
      ([key]) => key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
    );
    expect(watermarkSets).toHaveLength(1);
    expect(watermarkSets[0]![1] as number).toBeGreaterThan(0);
  });

  it('persistDeferredObjectiveObservationWatermark writes when no recorder exists', () => {
    // If the recorder was never constructed (e.g. plan engine never initialized), there is no
    // unflushed history to protect — the watermark should still advance so the next startup
    // doesn't redundantly re-scan from a stale point.
    const ctx = createAppContextMock();
    const setSpy = ctx.homey.settings.set as unknown as ReturnType<typeof vi.fn>;
    setSpy.mockClear();

    persistDeferredObjectiveObservationWatermark(ctx, undefined);

    const watermarkSets = setSpy.mock.calls.filter(
      ([key]) => key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
    );
    expect(watermarkSets).toHaveLength(1);
  });

  it('throttle-advances the deferred-objective watermark when observe ticks idle for 5+ minutes', () => {
    // Regression for Codex P2: without idle advancement, a long-running app with no
    // finalized deadlines keeps a stale watermark. Enabling a new objective + crash would
    // then back-fill that objective into pre-enable periods.
    const ctx = createAppContextMock({ deviceManager: {} as AppContext['deviceManager'] });
    ctx.deferredObjectivePlanHistoryRecorder = createDeferredObjectivePlanHistoryRecorder(ctx);
    const setSpy = ctx.homey.settings.set as unknown as ReturnType<typeof vi.fn>;
    setSpy.mockClear();

    capturedPlanEngineDeps.current = null;
    createPlanEngine(ctx);
    const observe = (capturedPlanEngineDeps.current as {
      observeDeferredObjectivePlanHistory: (diagnostics: readonly unknown[], nowMs: number) => void;
    }).observeDeferredObjectivePlanHistory;

    const baseMs = 1_000_000_000_000;
    const countWatermarkWrites = () => setSpy.mock.calls.filter(
      ([key]) => key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
    ).length;

    // First idle observe — closure-state `lastWatermarkPersistMs` is 0, the difference vs a
    // real-clock nowMs is far above the threshold, so the watermark advances on this first tick.
    observe([], baseMs);
    expect(countWatermarkWrites()).toBe(1);

    // Second observe one minute later, still idle. Below the 5-minute throttle → no write.
    observe([], baseMs + 60_000);
    expect(countWatermarkWrites()).toBe(1);

    // Third observe past the throttle threshold → second write.
    observe([], baseMs + 60_000 + 5 * 60_000 + 1);
    expect(countWatermarkWrites()).toBe(2);
  });

  it('does not throttle-advance the watermark while the recorder is dirty from a failed save', () => {
    // If the save callback returned false, the recorder stays dirty. Advancing the watermark
    // would skip the window containing the entries the next restart needs to re-save.
    const ctx = createAppContextMock({ deviceManager: {} as AppContext['deviceManager'] });
    const setSpy = ctx.homey.settings.set as unknown as ReturnType<typeof vi.fn>;
    // Save callback that always reports failure — drives the recorder into permanent dirty.
    const recorder = new DeferredObjectivePlanHistoryRecorder({
      load: () => null,
      save: () => false,
    });
    // Force a dirty record using a directly-pushed entry via observe.
    recorder.observe([{
      deviceId: 'dev',
      deviceName: 'd',
      objectiveId: 'dev:temperature',
      objectiveKind: 'temperature',
      enforcement: 'soft',
      status: 'on_track',
      reasonCode: 'planned_with_margin',
      targetPercent: null,
      currentPercent: null,
      targetTemperatureC: 65,
      currentTemperatureC: 50,
      deadlineAtMs: 1_000,
      deadlineLocalTime: '06:00',
      energyNeededKWh: 1,
      kWhPerPercent: null,
      kWhPerDegreeC: 1,
      rateConfidence: 'high',
      horizonBucketCount: 6,
      requestedMinimumStepId: null,
    }], 0);
    recorder.observe([], 1_000);
    expect(recorder.isDirty()).toBe(true);
    ctx.deferredObjectivePlanHistoryRecorder = recorder;
    setSpy.mockClear();

    capturedPlanEngineDeps.current = null;
    createPlanEngine(ctx);
    const observe = (capturedPlanEngineDeps.current as {
      observeDeferredObjectivePlanHistory: (diagnostics: readonly unknown[], nowMs: number) => void;
    }).observeDeferredObjectivePlanHistory;

    observe([], 1_000_000_000_000);
    observe([], 1_000_000_000_000 + 10 * 60_000);
    const watermarkWrites = setSpy.mock.calls.filter(
      ([key]) => key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
    ).length;
    expect(watermarkWrites).toBe(0);
  });

  it('does not advance the watermark when startup back-fill save fails', () => {
    // Existing watermark + enabled objective + plan-history settings.set throws.
    // The save callback returns false, flushIfDirty returns false, and runStartupBackfill
    // must leave the watermark in place so the next restart retries.
    const ctx = createAppContextMock();
    const getSpy = ctx.homey.settings.get as unknown as ReturnType<typeof vi.fn>;
    const setSpy = ctx.homey.settings.set as unknown as ReturnType<typeof vi.fn>;
    const oldWatermark = Date.now() - 48 * 60 * 60 * 1000;
    const passedDeadlineMs = Date.now() - 24 * 60 * 60 * 1000;
    getSpy.mockImplementation((key: string) => {
      if (key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK) return oldWatermark;
      if (key === 'deferred_objectives') {
        return {
          version: 1,
          objectivesByDeviceId: {
            dev_a: {
              enabled: true,
              kind: 'temperature',
              enforcement: 'soft',
              targetTemperatureC: 65,
              deadlineAtMs: passedDeadlineMs,
            },
          },
        };
      }
      return undefined;
    });
    setSpy.mockImplementation((key: string) => {
      if (key === 'deferred_objective_plan_history') {
        throw new Error('disk full');
      }
    });

    createDeferredObjectivePlanHistoryRecorder(ctx);

    const watermarkSets = setSpy.mock.calls.filter(
      ([key]) => key === DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
    );
    expect(watermarkSets).toHaveLength(0);
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
