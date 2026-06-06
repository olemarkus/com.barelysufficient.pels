import { registerDeadlineObjectiveCards } from '../../flowCards/deadlineObjectiveCards';
import {
  clearObjectiveForDevice,
  createDeferredObjectiveEndedBus,
  createDeferredObjectiveHoursRemainingBus,
  createDeferredObjectiveHoursRemainingTracker,
  createDeferredObjectivePlanRevisionBus,
  createDeferredObjectiveStatusBus,
  upsertObjectiveForDevice,
  type DeferredObjectiveActivePlanRecorder,
  type DeferredObjectiveEndedBus,
  type DeferredObjectiveEndedEvent,
  type DeferredObjectiveHoursRemainingBus,
  type DeferredObjectiveHoursRemainingTracker,
  type DeferredObjectivePlanHistoryRecorder,
  type DeferredObjectivePlanRevisionEvent,
  type DeferredObjectivePlanRevisionBus,
  type DeferredObjectiveSettingsV1,
  type DeferredObjectiveStatusBus,
} from '../../lib/objectives/deferredObjectives';
import { PER_DEVICE_OBJECTIVE_KEY_PREFIX } from '../../lib/objectives/deferredObjectives/objectiveStore';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import type {
  DeferredObjectiveActivePlanStatusV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
  DeferredObjectiveActivePlanRevisionV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { FlowCardDeps } from '../../flowCards/registerFlowCards';

// Fixed clock for deterministic deadlineAtMs assertions. 2026-01-01 05:00 UTC.
const MOCK_NOW_MS = Date.UTC(2026, 0, 1, 5, 0, 0);
const HH_MM_TO_UTC_MS = (hh: number, mm: number, dayOffset = 0): number => (
  Date.UTC(2026, 0, 1 + dayOffset, hh, mm, 0)
);

type CardListeners = {
  run?: (args: unknown, state?: unknown) => Promise<boolean> | boolean | void;
  autocomplete?: (query: string, args?: Record<string, unknown>) => Promise<Array<{ id: string; name: string }>> | Array<{ id: string; name: string }>;
  trigger: ReturnType<typeof vi.fn>;
};

type CardRegistry = Map<string, CardListeners>;

const buildCard = (registry: CardRegistry, id: string) => {
  const listeners: CardListeners = { trigger: vi.fn().mockResolvedValue(undefined) };
  registry.set(id, listeners);
  return {
    registerRunListener: (fn: CardListeners['run']) => { listeners.run = fn; },
    registerArgumentAutocompleteListener: (
      _arg: string,
      fn: CardListeners['autocomplete'],
    ) => { listeners.autocomplete = fn; },
    trigger: listeners.trigger,
  };
};

const createMockHomey = () => {
  // Seed a non-objective key so getKeys() is non-empty, as a real PELS store
  // always is: the per-key write guard treats an empty key list as a transient
  // store-wide flake (not a fresh create) and refuses.
  const settings = new Map<string, unknown>([['capacity_limit_kw', 5]]);
  const actions: CardRegistry = new Map();
  const triggers: CardRegistry = new Map();
  const conditions: CardRegistry = new Map();
  const homey = {
    flow: {
      getActionCard: (id: string) => buildCard(actions, id),
      getTriggerCard: (id: string) => buildCard(triggers, id),
      getConditionCard: (id: string) => buildCard(conditions, id),
    },
    settings: {
      get: (key: string) => settings.get(key),
      set: (key: string, value: unknown) => { settings.set(key, value); },
      unset: (key: string) => { settings.delete(key); },
      getKeys: () => [...settings.keys()],
    },
  };
  return { homey, settings, actions, triggers, conditions };
};

// Per-device-key helpers. Objectives now live under `deferred_objective.<id>`.
const seedObjectives = (
  settings: Map<string, unknown>,
  byDeviceId: DeferredObjectiveSettingsV1['objectivesByDeviceId'],
): void => {
  for (const [deviceId, entry] of Object.entries(byDeviceId)) {
    settings.set(`${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${deviceId}`, entry);
  }
};
const readObjective = (
  settings: Map<string, unknown>,
  deviceId: string,
): unknown => settings.get(`${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${deviceId}`);
const readObjectivesMap = (
  settings: Map<string, unknown>,
): DeferredObjectiveSettingsV1['objectivesByDeviceId'] => {
  const out: DeferredObjectiveSettingsV1['objectivesByDeviceId'] = {};
  for (const [key, value] of settings.entries()) {
    if (!key.startsWith(PER_DEVICE_OBJECTIVE_KEY_PREFIX)) continue;
    out[key.slice(PER_DEVICE_OBJECTIVE_KEY_PREFIX.length)] = value as never;
  }
  return out;
};

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> & { id: string; name: string }): TargetDeviceSnapshot => ({
  capabilities: [],
  targets: [],
  ...overrides,
} as TargetDeviceSnapshot);

const buildActivePlanRevision = (
  planStatus: DeferredObjectiveActivePlanStatusV1,
  overrides: Partial<DeferredObjectiveActivePlanRevisionV1> = {},
): DeferredObjectiveActivePlanRevisionV1 => ({
  revision: 1,
  revisedAtMs: MOCK_NOW_MS,
  computedFromPricesUpTo: null,
  reason: 'flow_card',
  hours: [],
  energyNeededKWh: 1,
  planStatus,
  ...overrides,
});

const buildActivePlan = (overrides: {
  deviceId?: string;
  deviceName?: string | null;
  planStatus?: DeferredObjectiveActivePlanStatusV1;
  pending?: boolean;
  latest?: DeferredObjectiveActivePlanRevisionV1 | null;
  deadlineAtMs?: number;
} = {}): DeferredObjectiveActivePlanV1 => {
  const deviceId = overrides.deviceId ?? 'heater-1';
  const pending = overrides.pending ?? false;
  const latest = overrides.latest ?? (pending ? null : buildActivePlanRevision(overrides.planStatus ?? 'on_track'));
  return {
    deviceId,
    deviceName: overrides.deviceName ?? 'Boiler',
    objectiveKind: 'temperature',
    targetTemperatureC: 55,
    targetPercent: null,
    deadlineAtMs: overrides.deadlineAtMs ?? HH_MM_TO_UTC_MS(7, 0),
    startedAtMs: MOCK_NOW_MS,
    pending,
    objectiveSignature: `${deviceId}:sig`,
    original: latest,
    latest,
  };
};

const buildActivePlans = (
  plans: DeferredObjectiveActivePlanV1[],
): DeferredObjectiveActivePlansV1 => ({
  version: 1,
  plansByDeviceId: Object.fromEntries(plans.map((plan) => [plan.deviceId, plan])),
});

const buildPlanRevisionEvent = (
  overrides: Omit<Partial<DeferredObjectivePlanRevisionEvent>, 'revision'> & {
    planStatus?: DeferredObjectiveActivePlanStatusV1;
    revision?: Partial<DeferredObjectiveActivePlanRevisionV1>;
  } = {},
): DeferredObjectivePlanRevisionEvent => {
  const {
    planStatus: eventPlanStatus,
    revision: revisionOverrides = {},
    ...eventOverrides
  } = overrides;
  const planStatus = eventPlanStatus ?? revisionOverrides.planStatus ?? 'on_track';
  const revision = buildActivePlanRevision(planStatus, {
    reason: 'schedule_revised',
    ...revisionOverrides,
    planStatus,
  });
  return {
    eventType: 'revision_written',
    deviceId: 'heater-1',
    deviceName: 'Boiler',
    objectiveKind: 'temperature',
    reason: revision.reason,
    previousPlanStatus: 'on_track',
    previousWasPending: false,
    allocationChanged: false,
    projectedFinishAtMs: null,
    revision,
    ...eventOverrides,
  };
};

const buildHoursRemainingDiagnostic = (
  overrides: Partial<DeferredObjectiveDiagnostic> & {
    deviceId: string;
    deadlineAtMs: number | null;
  },
): DeferredObjectiveDiagnostic => ({
  deviceId: overrides.deviceId,
  deviceName: 'Garage charger',
  objectiveId: `${overrides.deviceId}:ev_soc`,
  objectiveKind: 'ev_soc',
  enforcement: 'soft',
  status: 'on_track',
  reasonCode: 'objective_progress_stale',
  targetPercent: 80,
  currentPercent: 60,
  deadlineAtMs: overrides.deadlineAtMs,
  deadlineLocalTime: '07:00',
  energyNeededKWh: 4,
  kWhPerPercent: 0.2,
  kWhPerDegreeC: null,
  rateConfidence: null,
  displayConfidence: null,
  kwhPerUnitSource: null,
  kwhPerUnitAcceptedSamples: 0,
  kwhPerUnitLastAcceptedAtMs: null,
  planningSpeedKw: 2,
  horizonBucketCount: 2,
  dailyBudgetExhaustedBucketCount: 0,
  expectedStepId: null,
  ...overrides,
});

type MockRecorders = {
  activePlanRecorder: DeferredObjectiveActivePlanRecorder;
  planHistoryRecorder: DeferredObjectivePlanHistoryRecorder;
};

// Spyable stand-ins for the two recorders the device-scoped write ops notify.
// Only the methods `applyDeferredObjectiveChange` + the ops touch are stubbed.
const buildMockRecorders = (): MockRecorders => ({
  activePlanRecorder: {
    markPending: vi.fn(),
    clearForDevice: vi.fn(),
    flushIfDirty: vi.fn(),
    getActivePlansSnapshot: vi.fn(() => ({ version: 1, plansByDeviceId: {} })),
  } as unknown as DeferredObjectiveActivePlanRecorder,
  planHistoryRecorder: {
    finalizeForUserChange: vi.fn(),
    finalizeElapsedDeadline: vi.fn(),
    flushIfDirty: vi.fn(),
  } as unknown as DeferredObjectivePlanHistoryRecorder,
});

const buildDeps = (overrides: {
  snapshot: TargetDeviceSnapshot[];
  bus?: DeferredObjectiveStatusBus;
  planRevisionBus?: DeferredObjectivePlanRevisionBus;
  endedBus?: DeferredObjectiveEndedBus;
  hoursRemainingBus?: DeferredObjectiveHoursRemainingBus;
  hoursRemainingTracker?: DeferredObjectiveHoursRemainingTracker;
  activePlans?: DeferredObjectiveActivePlansV1 | null;
  rebuildPlan?: ReturnType<typeof vi.fn>;
  recorders?: MockRecorders;
}): { deps: FlowCardDeps; mock: ReturnType<typeof createMockHomey>; recorders: MockRecorders } => {
  const mock = createMockHomey();
  const recorders = overrides.recorders ?? buildMockRecorders();
  const rebuildPlan = overrides.rebuildPlan ?? vi.fn();
  // Wire the device-scoped write ops over the mock homey settings + recorders,
  // exactly as appInit does in production — so the cards exercise the real
  // per-device-key write + notify/flush/rebuild chokepoint.
  const buildWriteDeps = (rebuildReason: string) => ({
    store: mock.homey.settings,
    activePlanRecorder: recorders.activePlanRecorder,
    planHistoryRecorder: recorders.planHistoryRecorder,
    rebuildPlan: () => rebuildPlan(rebuildReason),
    nowMs: MOCK_NOW_MS,
  });
  const deps = {
    homey: mock.homey,
    structuredLog: undefined,
    resolveModeName: (mode: string) => mode,
    getAllModes: () => new Set<string>(),
    getCurrentOperatingMode: () => 'Home',
    handleOperatingModeChange: async () => {},
    getCurrentPriceLevel: () => 'unknown' as never,
    recordPowerSample: async () => {},
    getCapacityGuard: () => undefined,
    getHeadroom: () => null,
    setCapacityLimit: () => {},
    getSnapshot: async () => overrides.snapshot,
    refreshSnapshot: async () => {},
    getHomeyDevicesForFlow: async () => [],
    reportFlowBackedCapability: () => ({ kind: 'noop', valueChanged: false, freshnessAdvanced: false, refreshSnapshot: false, rebuildPlan: false }) as never,
    reportSteppedLoadActualStep: () => 'unchanged' as never,
    getDeviceLoadSetting: async () => null,
    setExpectedOverride: () => false,
    storeFlowPriceData: () => ({ dateKey: '', storedCount: 0, missingHours: [] }),
    rebuildPlan,
    upsertDeferredObjectiveForDevice: (params: Parameters<typeof upsertObjectiveForDevice>[1]) => (
      upsertObjectiveForDevice(buildWriteDeps('deadline_objective_card_set'), params)
    ),
    clearDeferredObjectiveForDevice: (params: Parameters<typeof clearObjectiveForDevice>[1]) => (
      clearObjectiveForDevice(buildWriteDeps('deadline_objective_card_clear'), params)
    ),
    evaluateHeadroomForDevice: () => null,
    loadDailyBudgetSettings: () => {},
    updateDailyBudgetState: () => {},
    getCombinedHourlyPrices: () => null,
    getTimeZone: () => 'UTC',
    getNow: () => new Date(MOCK_NOW_MS),
    getStructuredLogger: () => undefined,
    log: () => {},
    debugStructured: () => {},
    error: () => {},
    getDeferredObjectiveActivePlans: () => (
      Object.prototype.hasOwnProperty.call(overrides, 'activePlans')
        ? overrides.activePlans
        : recorders.activePlanRecorder.getActivePlansSnapshot()
    ),
    getDeferredObjectiveStatusBus: () => overrides.bus,
    getDeferredObjectivePlanRevisionBus: () => overrides.planRevisionBus,
    getDeferredObjectiveEndedBus: () => overrides.endedBus,
    getDeferredObjectiveHoursRemainingBus: () => overrides.hoursRemainingBus,
    getDeferredObjectiveHoursRemainingTracker: () => overrides.hoursRemainingTracker,
  } as unknown as FlowCardDeps;
  return { deps, mock, recorders };
};

describe('deadline objective flow cards', () => {
  it('writes a temperature objective entry on set_temperature_deadline', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      rebuildPlan: vi.fn(),
    });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_temperature_deadline')!;
    await card.run!({ device: 'heater-1', target_c: 55, ready_by: '07:00' });

    const storedMap = readObjectivesMap(mock.settings);
    expect(storedMap['heater-1']).toEqual({
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 55,
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
    });
    expect(deps.rebuildPlan).toHaveBeenCalledWith('deadline_objective_card_set');
  });

  it('rejects malformed ready_by values', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
    });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_temperature_deadline')!;
    await expect(card.run!({ device: 'heater-1', target_c: 55, ready_by: '7am' }))
      .rejects.toThrow(/HH:mm/);
  });

  it('rejects target temperatures outside the device capability bounds', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({
        id: 'heater-1',
        name: 'Boiler',
        deviceType: 'temperature',
        targets: [{ id: 'target_temperature', value: 50, min: 30, max: 75, step: 0.5 } as never],
      })],
    });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_temperature_deadline')!;
    await expect(card.run!({ device: 'heater-1', target_c: 90, ready_by: '07:00' }))
      .rejects.toThrow(/between 30 and 75/);
    await expect(card.run!({ device: 'heater-1', target_c: 60, ready_by: '07:00' }))
      .resolves.toBe(true);
  });

  it('rejects when device is not in the snapshot', async () => {
    const { deps, mock } = buildDeps({ snapshot: [] });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_temperature_deadline')!;
    await expect(card.run!({ device: 'missing-1', target_c: 55, ready_by: '07:00' }))
      .rejects.toThrow(/was not found/);
  });

  it('set_temperature_deadline THROWS (retryable) when the write refuses on an empty-getKeys flake', async () => {
    // A store-wide empty getKeys() leaves the one-shot migration unable to
    // complete (marker unconfirmable), so the write refuses. The card must throw
    // so Homey surfaces a retryable failure instead of reporting success while
    // nothing persisted.
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      rebuildPlan: vi.fn(),
    });
    mock.homey.settings.getKeys = () => []; // transient store-wide flake
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_temperature_deadline')!;
    await expect(card.run!({ device: 'heater-1', target_c: 55, ready_by: '07:00' }))
      .rejects.toThrow(/try again/i);
    expect(readObjective(mock.settings, 'heater-1')).toBeUndefined(); // nothing persisted
    expect(deps.rebuildPlan).not.toHaveBeenCalled();
  });

  it('clear_deadline THROWS (retryable) when the clear refuses on an empty-getKeys flake', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      rebuildPlan: vi.fn(),
    });
    seedObjectives(mock.settings, {
      'heater-1': { enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 55, deadlineAtMs: HH_MM_TO_UTC_MS(7, 0) },
    });
    mock.homey.settings.getKeys = () => []; // transient store-wide flake
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('clear_deadline')!;
    await expect(card.run!({ device: 'heater-1' })).rejects.toThrow(/try again/i);
    expect(readObjective(mock.settings, 'heater-1')).toBeDefined(); // still persisted — not falsely cleared
    expect(deps.rebuildPlan).not.toHaveBeenCalled();
  });

  it('writes an EV objective on set_ev_charge_deadline with normal task behavior', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Charger', deviceClass: 'evcharger' })],
      rebuildPlan: vi.fn(),
    });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_ev_charge_deadline')!;
    await card.run!({
      device: { id: 'ev-1' },
      target_percent: 80,
      ready_by: '06:30',
    });
    const storedMap = readObjectivesMap(mock.settings);
    expect(storedMap['ev-1']).toEqual({
      enabled: true,
      kind: 'ev_soc',
      enforcement: 'soft',
      targetPercent: 80,
      deadlineAtMs: HH_MM_TO_UTC_MS(6, 30),
    });
  });

  it('ignores any stray enforcement arg and persists soft enforcement', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Charger', deviceClass: 'evcharger' })],
      rebuildPlan: vi.fn(),
    });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_ev_charge_deadline')!;
    // The action JSON no longer declares an `enforcement` arg, but a stray
    // value from a stale flow definition must not change the stored entry.
    await card.run!({
      device: { id: 'ev-1' },
      target_percent: 80,
      ready_by: '06:30',
      enforcement: { id: 'hard' },
    });
    const storedMap = readObjectivesMap(mock.settings);
    expect(storedMap['ev-1']?.enforcement).toBe('soft');
  });

  it('rejects set_ev_charge_deadline when the device is not in the snapshot', async () => {
    const { deps, mock } = buildDeps({ snapshot: [] });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_ev_charge_deadline')!;
    await expect(card.run!({
      device: 'missing-1',
      target_percent: 80,
      ready_by: '07:00',
    })).rejects.toThrow(/was not found/);
  });

  it('rejects set_ev_charge_deadline when the device is not an EV charger', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
    });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_ev_charge_deadline')!;
    await expect(card.run!({
      device: 'heater-1',
      target_percent: 80,
      ready_by: '07:00',
    })).rejects.toThrow(/not an EV charger/);
  });

  it('clear_deadline forgets the bus snapshot after the clear persists', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const rebuildPlan = vi.fn();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
      rebuildPlan,
    });
    bus.publish({
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'on_track',
      previousStatus: 'none',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: false,
      shortfallKwh: null,
      shortfallText: null,
    });
    seedObjectives(mock.settings, {
      'heater-1': {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 55,
        deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      },
    });
    registerDeadlineObjectiveCards(deps);
    await mock.actions.get('clear_deadline')!.run!({ device: 'heater-1' });
    expect(rebuildPlan).toHaveBeenCalledWith('deadline_objective_card_clear');
    expect(bus.hasActive('heater-1')).toBe(false);
  });

  it('notifies the recorders (replace + reseed) on a set_temperature_deadline update', async () => {
    const initial: DeferredObjectiveSettingsV1 = {
      version: 1,
      objectivesByDeviceId: {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 55,
          deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
        },
      },
    };
    const { deps, mock, recorders } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      rebuildPlan: vi.fn(),
    });
    seedObjectives(mock.settings, initial.objectivesByDeviceId);
    registerDeadlineObjectiveCards(deps);
    await mock.actions.get('set_temperature_deadline')!.run!({
      device: 'heater-1', target_c: 60, ready_by: '08:00',
    });
    // The prior future-deadline run is finalized as replaced and a fresh
    // pending plan is seeded — the device-scoped op runs applyDeferredObjectiveChange.
    expect(recorders.planHistoryRecorder.finalizeForUserChange)
      .toHaveBeenCalledWith('heater-1', MOCK_NOW_MS, 'replaced');
    expect(recorders.activePlanRecorder.markPending).toHaveBeenCalledTimes(1);
    const storedMap = readObjectivesMap(mock.settings);
    expect(storedMap['heater-1']).toMatchObject({
      targetTemperatureC: 60,
      deadlineAtMs: HH_MM_TO_UTC_MS(8, 0),
    });
  });

  it('preserves a granted rescue permission when the deadline is updated', async () => {
    const initial: DeferredObjectiveSettingsV1 = {
      version: 1,
      objectivesByDeviceId: {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 55,
          deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
          rescue: { exemptFromBudget: 'always' },
        },
      },
    };
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      rebuildPlan: vi.fn(),
    });
    seedObjectives(mock.settings, initial.objectivesByDeviceId);
    registerDeadlineObjectiveCards(deps);
    await mock.actions.get('set_temperature_deadline')!.run!({
      device: 'heater-1', target_c: 60, ready_by: '08:00',
    });
    const storedMap = readObjectivesMap(mock.settings);
    // The deadline/target update must not silently drop the standing rescue permission.
    expect(storedMap['heater-1']).toEqual({
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 60,
      deadlineAtMs: HH_MM_TO_UTC_MS(8, 0),
      rescue: { exemptFromBudget: 'always' },
    });
  });

  it('notifies the recorders (abandon + drop) on clear_deadline', async () => {
    const initial: DeferredObjectiveSettingsV1 = {
      version: 1,
      objectivesByDeviceId: {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 55,
          deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
        },
      },
    };
    const { deps, mock, recorders } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      rebuildPlan: vi.fn(),
    });
    seedObjectives(mock.settings, initial.objectivesByDeviceId);
    registerDeadlineObjectiveCards(deps);
    await mock.actions.get('clear_deadline')!.run!({ device: 'heater-1' });
    // The prior future-deadline run is finalized as abandoned and the active
    // plan dropped — the device-scoped op runs applyDeferredObjectiveChange.
    expect(recorders.planHistoryRecorder.finalizeForUserChange)
      .toHaveBeenCalledWith('heater-1', MOCK_NOW_MS, 'abandoned');
    expect(recorders.activePlanRecorder.clearForDevice).toHaveBeenCalledWith('heater-1');
  });

  it('set_temperature_deadline is per-device-key: leaves a sibling device\'s key untouched', async () => {
    // Per-device-key storage: creating a task on heater-1 writes ONLY its own
    // key; a sibling task under its own key is structurally untouchable.
    const recorders = buildMockRecorders();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      rebuildPlan: vi.fn(),
      recorders,
    });
    const sibling = {
      enabled: true, kind: 'ev_soc', enforcement: 'soft', targetPercent: 80,
      deadlineAtMs: MOCK_NOW_MS + 60_000,
    };
    seedObjectives(mock.settings, { 'other-1': sibling as never });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_temperature_deadline')!;
    await card.run!({ device: 'heater-1', target_c: 55, ready_by: '07:00' });
    // The new task is written; the sibling's key is byte-for-byte intact.
    expect(readObjective(mock.settings, 'heater-1')).toBeDefined();
    expect(readObjective(mock.settings, 'other-1')).toEqual(sibling);
    expect(deps.rebuildPlan).toHaveBeenCalled();
    expect(recorders.activePlanRecorder.markPending).toHaveBeenCalled();
  });

  it('removes the entry on clear_deadline', async () => {
    const initial: DeferredObjectiveSettingsV1 = {
      version: 1,
      objectivesByDeviceId: {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 55,
          deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
        },
      },
    };
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      rebuildPlan: vi.fn(),
    });
    seedObjectives(mock.settings, initial.objectivesByDeviceId);
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('clear_deadline')!;
    await card.run!({ device: 'heater-1' });
    const storedMap = readObjectivesMap(mock.settings);
    expect(storedMap).toEqual({});
  });

  it('temperature autocomplete excludes EV chargers', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [
        buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' }),
        buildDevice({ id: 'ev-1', name: 'Charger', deviceClass: 'evcharger' }),
      ],
    });
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('set_temperature_deadline')!;
    const options = await card.autocomplete!('') as Array<{ id: string }>;
    expect(options.map((opt) => opt.id)).toEqual(['heater-1']);
  });

  it('deadline_status_is matches at-risk as its own smart task status', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      activePlans: buildActivePlans([buildActivePlan({ planStatus: 'at_risk' })]),
    });
    seedObjectives(mock.settings, {
      'heater-1': {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 55,
        deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      },
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;
    expect(await condition.run!({ device: 'heater-1', status: 'at_risk' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'on_track' })).toBe(false);
    expect(await condition.run!({ device: 'heater-1', status: 'unachievable' })).toBe(false);
  });

  it('deadline_status_is returns true for waiting when a task has no status yet', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;
    seedObjectives(mock.settings, {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 55,
          deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
        },
      });
    expect(await condition.run!({ device: 'heater-1', status: 'waiting' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'pending_prices' })).toBe(true);
  });

  it('deadline_status_is returns false when active-plan state is unavailable', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      activePlans: null,
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;
    seedObjectives(mock.settings, {
      'heater-1': {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 55,
        deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      },
    });

    expect(await condition.run!({ device: 'heater-1', status: 'waiting' })).toBe(false);
    expect(await condition.run!({ device: 'heater-1', status: 'on_track' })).toBe(false);
  });

  it('deadline_status_is maps compatibility status args to active smart task statuses', async () => {
    const activePlans = buildActivePlans([buildActivePlan({ planStatus: 'cannot_meet' })]);
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      activePlans,
    });
    seedObjectives(mock.settings, {
      'heater-1': {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 55,
        deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      },
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;

    expect(await condition.run!({ device: 'heater-1', status: 'unachievable' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'cannot_finish' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'missed' })).toBe(false);

    activePlans.plansByDeviceId['heater-1'] = buildActivePlan({ planStatus: 'satisfied' });
    expect(await condition.run!({ device: 'heater-1', status: 'satisfied' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'done' })).toBe(true);
  });

  // Backward-compat regression: the initial in-dev `deadline_status_is`
  // dropdown (2026-05-10 → 2026-05-12, never shipped to a published release —
  // v2.7.0 bumped 2026-05-16) exposed 'none' to mean "no active smart task".
  // The `isLegacyNoneStatusMatch` guard keeps any flows carrying that id
  // working — both pre-release test installs from that window and flows that
  // were hand-edited at the JSON level (Homey allows it for advanced users).
  it('deadline_status_is accepts legacy none id as "no active task" from initial release', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;

        expect(await condition.run!({ device: 'heater-1', status: 'none' })).toBe(true);

    seedObjectives(mock.settings, {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 55,
          deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
        },
      });
    expect(await condition.run!({ device: 'heater-1', status: 'none' })).toBe(false);
  });

  it('deadline_status_is returns false for completely unknown status ids', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      activePlans: buildActivePlans([buildActivePlan({ planStatus: 'on_track' })]),
    });
    seedObjectives(mock.settings, {
      'heater-1': {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 55,
        deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      },
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;
    expect(await condition.run!({ device: 'heater-1', status: 'missed' })).toBe(false);
    expect(await condition.run!({ device: 'heater-1', status: 'unknown_future_id' })).toBe(false);
    expect(await condition.run!({ device: 'heater-1', status: '' })).toBe(false);
  });

  it('does not fire status_changed from live status bus transitions', () => {
    const bus = createDeferredObjectiveStatusBus();
    const planRevisionBus = createDeferredObjectivePlanRevisionBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
      planRevisionBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;

    bus.publish({
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'at_risk',
      previousStatus: 'on_track',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: false,
      shortfallKwh: null,
      shortfallText: null,
    });

    expect(trigger.trigger).not.toHaveBeenCalled();
  });

  it('publishes status_changed from settled active-plan revision events', async () => {
    const planRevisionBus = createDeferredObjectivePlanRevisionBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      planRevisionBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;

    planRevisionBus.publish(buildPlanRevisionEvent({
      previousPlanStatus: 'on_track',
      planStatus: 'at_risk',
    }));
    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    const [tokens, state] = trigger.trigger.mock.calls[0]!;
    expect(tokens).toEqual({
      device_name: 'Boiler',
      status: 'at_risk',
    });
    expect(state).toEqual({ deviceId: 'heater-1' });
    expect(await trigger.run!({ device: 'heater-1' }, state)).toBe(true);
    expect(await trigger.run!({ device: 'heater-2' }, state)).toBe(false);

    planRevisionBus.publish(buildPlanRevisionEvent({
      previousPlanStatus: 'at_risk',
      planStatus: 'on_track',
    }));
    expect(trigger.trigger).toHaveBeenCalledTimes(2);
    expect(trigger.trigger.mock.calls[1]![0]).toEqual({
      device_name: 'Boiler',
      status: 'on_track',
    });

    planRevisionBus.publish(buildPlanRevisionEvent({
      previousPlanStatus: 'on_track',
      planStatus: 'cannot_meet',
    }));
    expect(trigger.trigger).toHaveBeenCalledTimes(3);
    expect(trigger.trigger.mock.calls[2]![0]).toEqual({
      device_name: 'Boiler',
      status: 'unachievable',
    });
  });

  it('publishes status_changed when a pending task receives its first settled plan', () => {
    const planRevisionBus = createDeferredObjectivePlanRevisionBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      planRevisionBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;

    planRevisionBus.publish(buildPlanRevisionEvent({
      previousPlanStatus: null,
      previousWasPending: true,
      planStatus: 'on_track',
    }));

    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    const [tokens, state] = trigger.trigger.mock.calls[0]!;
    expect(tokens).toEqual({
      device_name: 'Boiler',
      status: 'on_track',
    });
    expect(state).toEqual({ deviceId: 'heater-1' });
  });

  it('publishes waiting when a settled task is replaced by a pending plan', () => {
    const planRevisionBus = createDeferredObjectivePlanRevisionBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      planRevisionBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;

    planRevisionBus.publish({
      eventType: 'pending_written',
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      objectiveKind: 'temperature',
      reason: 'pending',
      previousPlanStatus: 'on_track',
      previousWasPending: false,
      allocationChanged: false,
      projectedFinishAtMs: null,
      revision: null,
    });

    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    const [tokens, state] = trigger.trigger.mock.calls[0]!;
    expect(tokens).toEqual({
      device_name: 'Boiler',
      status: 'waiting',
    });
    expect(state).toEqual({ deviceId: 'heater-1' });
  });

  it('does not fire on the first settled revision of a freshly discovered task', () => {
    const planRevisionBus = createDeferredObjectivePlanRevisionBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      planRevisionBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;

    planRevisionBus.publish(buildPlanRevisionEvent({
      previousPlanStatus: null,
      previousWasPending: false,
      planStatus: 'on_track',
    }));
    expect(trigger.trigger).not.toHaveBeenCalled();

    // Subsequent settled status change now has prior public status.
    planRevisionBus.publish(buildPlanRevisionEvent({
      previousPlanStatus: 'on_track',
      planStatus: 'at_risk',
    }));
    expect(trigger.trigger).toHaveBeenCalledTimes(1);
  });

  it('does not fire when settled raw statuses map to the same public status', () => {
    const planRevisionBus = createDeferredObjectivePlanRevisionBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      planRevisionBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;

    planRevisionBus.publish(buildPlanRevisionEvent({
      previousPlanStatus: 'cannot_meet',
      planStatus: 'invalid',
    }));
    expect(trigger.trigger).not.toHaveBeenCalled();
  });

  it('deadline_status_is prefers settled active-plan status over the live status bus', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
      activePlans: buildActivePlans([buildActivePlan({ planStatus: 'on_track' })]),
    });
    seedObjectives(mock.settings, {
      'heater-1': {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 55,
        deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      },
    });
    registerDeadlineObjectiveCards(deps);
    bus.publish({
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'at_risk',
      previousStatus: 'on_track',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: false,
      shortfallKwh: null,
      shortfallText: null,
    });
    const condition = mock.conditions.get('deadline_status_is')!;
    expect(await condition.run!({ device: 'heater-1', status: 'on_track' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'at_risk' })).toBe(false);
  });

  it('deadline_status_is returns false after the smart-task deadline has passed', async () => {
    const activePlans = buildActivePlans([buildActivePlan({
      planStatus: 'at_risk',
      deadlineAtMs: HH_MM_TO_UTC_MS(4, 0),
    })]);
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      activePlans,
    });
    seedObjectives(mock.settings, {
      'heater-1': {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 55,
        deadlineAtMs: HH_MM_TO_UTC_MS(4, 0),
      },
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;
    expect(await condition.run!({ device: 'heater-1', status: 'at_risk' })).toBe(false);
    expect(await condition.run!({ device: 'heater-1', status: 'waiting' })).toBe(false);

    delete activePlans.plansByDeviceId['heater-1'];
    expect(await condition.run!({ device: 'heater-1', status: 'waiting' })).toBe(false);
  });

  it('publishes deadline_ended with stable outcome and numeric shortfall', async () => {
    const endedBus = createDeferredObjectiveEndedBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      endedBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_ended')!;

    const missedEvent: DeferredObjectiveEndedEvent = {
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      objectiveKind: 'temperature',
      outcome: 'missed',
      targetTemperatureC: 55,
      targetPercent: null,
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      finalizedAtMs: HH_MM_TO_UTC_MS(7, 1),
      metAtMs: null,
      finalProgressC: 50,
      finalProgressPercent: null,
    };
    endedBus.publish(missedEvent);

    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    const [tokens, state] = trigger.trigger.mock.calls[0]!;
    expect(tokens).toEqual({
      device_name: 'Boiler',
      outcome: 'missed',
      shortfall: 5,
      shortfall_known: true,
    });
    expect(state).toEqual({ deviceId: 'heater-1' });
    expect(await trigger.run!({ device: 'heater-1' }, state)).toBe(true);
    expect(await trigger.run!({ device: 'heater-2' }, state)).toBe(false);

    // Succeeded zeroes the shortfall.
    endedBus.publish({
      ...missedEvent,
      outcome: 'succeeded',
      metAtMs: HH_MM_TO_UTC_MS(6, 30),
      finalProgressC: 55,
    });
    expect(trigger.trigger).toHaveBeenCalledTimes(2);
    expect(trigger.trigger.mock.calls[1]![0]).toEqual({
      device_name: 'Boiler',
      outcome: 'succeeded',
      shortfall: 0,
      shortfall_known: true,
    });
  });

  it('publishes deadline_ended with shortfall_known=false when the device-side delta is unobservable', async () => {
    const endedBus = createDeferredObjectiveEndedBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      endedBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_ended')!;

    // Missed outcome with no `finalProgressC` sample — the SDK forces a
    // numeric 0 fallback, so `shortfall_known` must signal "unknown".
    endedBus.publish({
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      objectiveKind: 'temperature',
      outcome: 'missed',
      targetTemperatureC: 55,
      targetPercent: null,
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      finalizedAtMs: HH_MM_TO_UTC_MS(7, 1),
      metAtMs: null,
      finalProgressC: null,
      finalProgressPercent: null,
    });
    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    expect(trigger.trigger.mock.calls[0]![0]).toEqual({
      device_name: 'Boiler',
      outcome: 'missed',
      shortfall: 0,
      shortfall_known: false,
    });

    // Abandoned outcome on an EV charger with both target and final-progress
    // samples present — delta is observable, so `shortfall_known` is true.
    endedBus.publish({
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      objectiveKind: 'ev_soc',
      outcome: 'abandoned',
      targetTemperatureC: null,
      targetPercent: 80,
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      finalizedAtMs: HH_MM_TO_UTC_MS(7, 1),
      metAtMs: null,
      finalProgressC: null,
      finalProgressPercent: 73,
    });
    expect(trigger.trigger).toHaveBeenCalledTimes(2);
    expect(trigger.trigger.mock.calls[1]![0]).toEqual({
      device_name: 'Boiler',
      outcome: 'abandoned',
      shortfall: 7,
      shortfall_known: true,
    });
  });

  it('publishes deadline_plan_changed with kWh, charge hours and projected finish tokens', async () => {
    const planRevisionBus = createDeferredObjectivePlanRevisionBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      planRevisionBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_plan_changed')!;

    const hourStartA = Date.UTC(2026, 0, 1, 1, 0, 0);
    const hourStartB = Date.UTC(2026, 0, 1, 2, 0, 0);
    const hourStartC = Date.UTC(2026, 0, 1, 5, 0, 0);
    // Last bucket fills 36 minutes of its hour (1.5 of 2.5 kWh capacity), so
    // projected finish lands at 05:36 — the producer already resolved the ms.
    const projectedFinishAtMs = hourStartC + Math.round((1.5 / 2.5) * 3600000);
    planRevisionBus.publish({
      eventType: 'revision_written',
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'prices_revised',
      previousPlanStatus: 'on_track',
      previousWasPending: false,
      allocationChanged: true,
      projectedFinishAtMs,
      revision: {
        revision: 2,
        revisedAtMs: hourStartA,
        computedFromPricesUpTo: hourStartC + 3600000,
        reason: 'prices_revised',
        planStatus: 'on_track',
        energyNeededKWh: 6.5,
        hours: [
          { startsAtMs: hourStartA, plannedKWh: 2.5 },
          { startsAtMs: hourStartB, plannedKWh: 2.5 },
          { startsAtMs: hourStartC, plannedKWh: 1.5 },
        ],
      },
    });

    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    const [tokens, state] = trigger.trigger.mock.calls[0]!;
    expect(tokens).toEqual({
      device_name: 'Garage charger',
      remaining_kwh: 6.5,
      planned_hours: 3,
      projected_finish_local_time: '05:36',
    });
    expect(state).toEqual({ deviceId: 'ev-1' });
    expect(await trigger.run!({ device: 'ev-1' }, state)).toBe(true);
    expect(await trigger.run!({ device: 'ev-2' }, state)).toBe(false);

    // allocationChanged === false should not fire the trigger.
    planRevisionBus.publish({
      eventType: 'revision_written',
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'rate_refined',
      previousPlanStatus: 'on_track',
      previousWasPending: false,
      allocationChanged: false,
      projectedFinishAtMs,
      revision: {
        revision: 3,
        revisedAtMs: hourStartA,
        computedFromPricesUpTo: hourStartC + 3600000,
        reason: 'rate_refined',
        planStatus: 'on_track',
        energyNeededKWh: 6.5,
        hours: [
          { startsAtMs: hourStartA, plannedKWh: 2.5 },
          { startsAtMs: hourStartB, plannedKWh: 2.5 },
          { startsAtMs: hourStartC, plannedKWh: 1.5 },
        ],
      },
    });
    expect(trigger.trigger).toHaveBeenCalledTimes(1);
  });

  it('emits planned_hours that drops as the schedule shrinks', async () => {
    const planRevisionBus = createDeferredObjectivePlanRevisionBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      planRevisionBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_plan_changed')!;
    const hourStartA = Date.UTC(2026, 0, 1, 1, 0, 0);
    const hourStartB = Date.UTC(2026, 0, 1, 2, 0, 0);
    const hourStartC = Date.UTC(2026, 0, 1, 5, 0, 0);

    // First revision: 3 planned hours.
    planRevisionBus.publish({
      eventType: 'revision_written',
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'prices_revised',
      previousPlanStatus: 'on_track',
      previousWasPending: false,
      allocationChanged: true,
      projectedFinishAtMs: hourStartC,
      revision: {
        revision: 1,
        revisedAtMs: hourStartA,
        computedFromPricesUpTo: hourStartC + 3600000,
        reason: 'prices_revised',
        planStatus: 'on_track',
        energyNeededKWh: 5.0,
        hours: [
          { startsAtMs: hourStartA, plannedKWh: 2.0 },
          { startsAtMs: hourStartB, plannedKWh: 2.0 },
          { startsAtMs: hourStartC, plannedKWh: 1.0 },
        ],
      },
    });
    expect(trigger.trigger.mock.calls[0]![0]).toMatchObject({ planned_hours: 3 });

    // Later revision: schedule shrunk to a single remaining hour. The token
    // must reflect the current schedule rather than the historic peak.
    planRevisionBus.publish({
      eventType: 'revision_written',
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'prices_revised',
      previousPlanStatus: 'on_track',
      previousWasPending: false,
      allocationChanged: true,
      projectedFinishAtMs: hourStartC,
      revision: {
        revision: 2,
        revisedAtMs: hourStartC,
        computedFromPricesUpTo: hourStartC + 3600000,
        reason: 'prices_revised',
        planStatus: 'on_track',
        energyNeededKWh: 1.0,
        hours: [
          { startsAtMs: hourStartC, plannedKWh: 1.0 },
        ],
      },
    });
    expect(trigger.trigger.mock.calls[1]![0]).toMatchObject({ planned_hours: 1 });
  });

  it('swallows token-build errors so a bad plan-revision event cannot crash the publisher', () => {
    const planRevisionBus = createDeferredObjectivePlanRevisionBus();
    const errors: unknown[][] = [];
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      planRevisionBus,
    });
    (deps as { error: (...args: unknown[]) => void }).error = (...args: unknown[]) => { errors.push(args); };
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_plan_changed')!;

    expect(() => planRevisionBus.publish({
      eventType: 'revision_written',
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'prices_revised',
      previousPlanStatus: null,
      previousWasPending: false,
      allocationChanged: true,
      // Force buildPlanChangedTokens to throw by giving it a malformed revision.
      projectedFinishAtMs: 0,
      revision: null as unknown as never,
    })).not.toThrow();
    expect(trigger.trigger).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toMatch(/Failed to build deadline_plan_changed tokens/);
  });

  it('has_active_deadline returns true only when an enabled entry exists', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('has_active_deadline')!;

        expect(await condition.run!({ device: 'heater-1' })).toBe(false);

    seedObjectives(mock.settings, {
        'heater-1': {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 55,
          deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
        },
      });
    expect(await condition.run!({ device: 'heater-1' })).toBe(true);
  });

  it('re-arms smart_task_hours_remaining after clear_deadline and same-deadline re-add', async () => {
    const hoursRemainingBus = createDeferredObjectiveHoursRemainingBus();
    const hoursRemainingTracker = createDeferredObjectiveHoursRemainingTracker();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      hoursRemainingBus,
      hoursRemainingTracker,
      rebuildPlan: vi.fn(),
    });
    registerDeadlineObjectiveCards(deps);
    const setCard = mock.actions.get('set_ev_charge_deadline')!;
    const clearCard = mock.actions.get('clear_deadline')!;
    const trigger = mock.triggers.get('smart_task_hours_remaining')!;
    const deadlineAtMs = HH_MM_TO_UTC_MS(7, 0);
    const nowMs = deadlineAtMs - 2 * 60 * 60 * 1000;
    const diagnostics = [buildHoursRemainingDiagnostic({ deviceId: 'ev-1', deadlineAtMs })];

    await setCard.run!({ device: 'ev-1', target_percent: 80, ready_by: '07:00' });
    hoursRemainingTracker.observe({ diagnostics, nowMs, bus: hoursRemainingBus });
    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    let state = trigger.trigger.mock.calls[0]![1];
    expect(await trigger.run!({ device: 'ev-1', hours: 2 }, state)).toBe(true);

    await clearCard.run!({ device: 'ev-1' });
    await setCard.run!({ device: 'ev-1', target_percent: 80, ready_by: '07:00' });
    hoursRemainingTracker.observe({ diagnostics, nowMs, bus: hoursRemainingBus });
    expect(trigger.trigger).toHaveBeenCalledTimes(2);
    state = trigger.trigger.mock.calls[1]![1];
    expect(state).toEqual({ deviceId: 'ev-1', hoursRemaining: 2, previousHoursRemaining: null });
    expect(await trigger.run!({ device: 'ev-1', hours: 2 }, state)).toBe(true);

    hoursRemainingTracker.observe({ diagnostics, nowMs, bus: hoursRemainingBus });
    expect(trigger.trigger).toHaveBeenCalledTimes(2);
  });

  it('publishes smart_task_hours_remaining tokens and fires only on its own threshold crossing', async () => {
    const hoursRemainingBus = createDeferredObjectiveHoursRemainingBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      hoursRemainingBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('smart_task_hours_remaining')!;

    hoursRemainingBus.publish({
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      hoursRemaining: 2,
      previousHoursRemaining: 3,
    });

    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    const [tokens, state] = trigger.trigger.mock.calls[0]!;
    expect(tokens).toEqual({ device_name: 'Garage charger', hours_remaining: 2 });
    expect(state).toEqual({ deviceId: 'ev-1', hoursRemaining: 2, previousHoursRemaining: 3 });

    // Device filter: only the matching device fires.
    expect(await trigger.run!({ device: 'ev-1', hours: 2 }, state)).toBe(true);
    expect(await trigger.run!({ device: 'ev-2', hours: 2 }, state)).toBe(false);

    // Threshold gate: this 3h->2h crossing is the crossing of the "2h" mark
    // only. A "5h" flow already crossed its mark on an earlier (un-published)
    // boundary — `previous (3) <= 5` means this is not its crossing, so it must
    // not fire. A "1h" flow hasn't been reached yet (`2 <= 1` is false).
    expect(await trigger.run!({ device: 'ev-1', hours: 5 }, state)).toBe(false);
    expect(await trigger.run!({ device: 'ev-1', hours: 3 }, state)).toBe(false);
    expect(await trigger.run!({ device: 'ev-1', hours: 1 }, state)).toBe(false);
  });

  it('fires a given threshold exactly once across a multi-boundary descent', async () => {
    const hoursRemainingBus = createDeferredObjectiveHoursRemainingBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      hoursRemainingBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('smart_task_hours_remaining')!;

    // Domain emits one crossing per integer boundary as remaining drops from
    // first-observation (boundary 4, previous null) down to 1. A flow watching
    // any single threshold must fire on exactly one of these crossings — the
    // one that drops from above that threshold to <= it — never twice (the
    // `previousHoursRemaining > threshold` gate is what prevents the later,
    // lower crossings from re-firing under the `<=` comparison).
    const crossings = [
      { hoursRemaining: 4, previousHoursRemaining: null as number | null },
      { hoursRemaining: 3, previousHoursRemaining: 4 },
      { hoursRemaining: 2, previousHoursRemaining: 3 },
      { hoursRemaining: 1, previousHoursRemaining: 2 },
    ];

    const fireCountFor = async (threshold: number): Promise<number> => {
      trigger.trigger.mockClear();
      let fires = 0;
      for (const crossing of crossings) {
        hoursRemainingBus.publish({ deviceId: 'ev-1', deviceName: 'Garage charger', ...crossing });
        const state = trigger.trigger.mock.calls.at(-1)![1];
        if (await trigger.run!({ device: 'ev-1', hours: threshold }, state)) fires += 1;
      }
      return fires;
    };

    expect(await fireCountFor(4)).toBe(1);
    expect(await fireCountFor(2)).toBe(1);
    expect(await fireCountFor(1)).toBe(1);
  });

  it('fires once when the first observed crossing is already under the threshold (previous null)', async () => {
    const hoursRemainingBus = createDeferredObjectiveHoursRemainingBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      hoursRemainingBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('smart_task_hours_remaining')!;

    // Freshly armed / re-armed: previousHoursRemaining is null. A flow set to
    // 2h must still fire once even though there was no prior "above" sample.
    hoursRemainingBus.publish({
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      hoursRemaining: 1,
      previousHoursRemaining: null,
    });
    const state = trigger.trigger.mock.calls[0]![1];
    expect(await trigger.run!({ device: 'ev-1', hours: 2 }, state)).toBe(true);
  });

  it('does not re-fire smart_task_hours_remaining across an app restart while remaining stays under the threshold', async () => {
    // End-to-end restart regression: with a pre-existing deadline already
    // below the user-configured 2h threshold, restarting the app (i.e.
    // constructing a fresh tracker against the persisted latch) must NOT
    // trigger a duplicate Flow fire on the first observation. The card's
    // user-visible contract is "fires once and re-arms when the ready-by time
    // is rescheduled".
    const persistedStore: { value: unknown } = { value: undefined };
    const buildPersistentTracker = (): DeferredObjectiveHoursRemainingTracker => (
      createDeferredObjectiveHoursRemainingTracker({
        load: () => persistedStore.value,
        save: (latch) => { persistedStore.value = latch; },
      })
    );

    // ---- Boot 1: pre-restart ----
    const before = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      hoursRemainingBus: createDeferredObjectiveHoursRemainingBus(),
      hoursRemainingTracker: buildPersistentTracker(),
    });
    registerDeadlineObjectiveCards(before.deps);
    const beforeTrigger = before.mock.triggers.get('smart_task_hours_remaining')!;
    const deadlineAtMs = HH_MM_TO_UTC_MS(7, 0);
    const diagnostics = [buildHoursRemainingDiagnostic({ deviceId: 'ev-1', deadlineAtMs })];
    // Pre-restart cycle: ev-1 crosses the 2h boundary, fires once.
    before.deps.getDeferredObjectiveHoursRemainingTracker!()!.observe({
      diagnostics,
      nowMs: deadlineAtMs - 2 * 60 * 60 * 1000,
      bus: before.deps.getDeferredObjectiveHoursRemainingBus!()!,
    });
    expect(beforeTrigger.trigger).toHaveBeenCalledTimes(1);

    // ---- Boot 2: post-restart ----
    // A user-configured 2h-or-fewer Flow exists. Without persisted latch,
    // boundary 1's first-after-restart crossing would carry
    // `previousHoursRemaining = null` and the run listener's
    // `previous === null` short-circuit would let the 2h flow re-fire. With
    // the persisted latch, `previous = 2` → the 2h flow's
    // `previous > threshold` gate is false (2 > 2 is false) and it stays
    // silent.
    const after = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      hoursRemainingBus: createDeferredObjectiveHoursRemainingBus(),
      hoursRemainingTracker: buildPersistentTracker(),
    });
    registerDeadlineObjectiveCards(after.deps);
    const afterTrigger = after.mock.triggers.get('smart_task_hours_remaining')!;
    after.deps.getDeferredObjectiveHoursRemainingTracker!()!.observe({
      diagnostics,
      nowMs: deadlineAtMs - (60 * 60 * 1000), // 1h remaining now
      bus: after.deps.getDeferredObjectiveHoursRemainingBus!()!,
    });
    // The 1h boundary IS a fresh crossing (1 < 2), so the bus does publish
    // — what we're checking is the run-listener's gate for a 2h-threshold
    // flow.
    expect(afterTrigger.trigger).toHaveBeenCalledTimes(1);
    const state = afterTrigger.trigger.mock.calls[0]![1];
    // A 2h-threshold Flow fired pre-restart and must not re-fire post-restart.
    expect(await afterTrigger.run!({ device: 'ev-1', hours: 2 }, state)).toBe(false);
    // A 1h-threshold Flow IS this crossing's threshold — it fires.
    expect(await afterTrigger.run!({ device: 'ev-1', hours: 1 }, state)).toBe(true);
  });

  it('does not fire smart_task_hours_remaining when the threshold arg is missing or non-finite', async () => {
    const hoursRemainingBus = createDeferredObjectiveHoursRemainingBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'ev-1', name: 'Garage charger', deviceClass: 'evcharger' })],
      hoursRemainingBus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('smart_task_hours_remaining')!;
    const state = { deviceId: 'ev-1', hoursRemaining: 1, previousHoursRemaining: null };
    expect(await trigger.run!({ device: 'ev-1' }, state)).toBe(false);
    expect(await trigger.run!({ device: 'ev-1', hours: 'soon' }, state)).toBe(false);
  });
});
