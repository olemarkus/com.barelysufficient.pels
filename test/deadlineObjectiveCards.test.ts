import { registerDeadlineObjectiveCards } from '../flowCards/deadlineObjectiveCards';
import {
  createDeferredObjectivePlanRevisionBus,
  createDeferredObjectiveStatusBus,
  createEmptyDeferredObjectiveSettings,
  type DeferredObjectivePlanRevisionBus,
  type DeferredObjectiveSettingsV1,
  type DeferredObjectiveStatusBus,
  type DeferredObjectiveStatusSnapshot,
} from '../lib/plan/deferredObjectives';
import type { TargetDeviceSnapshot } from '../lib/utils/types';
import type { FlowCardDeps } from '../flowCards/registerFlowCards';

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
  const settings = new Map<string, unknown>();
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
    },
  };
  return { homey, settings, actions, triggers, conditions };
};

const buildDevice = (overrides: Partial<TargetDeviceSnapshot> & { id: string; name: string }): TargetDeviceSnapshot => ({
  capabilities: [],
  targets: [],
  ...overrides,
} as TargetDeviceSnapshot);

const buildDeps = (overrides: {
  snapshot: TargetDeviceSnapshot[];
  bus?: DeferredObjectiveStatusBus;
  planRevisionBus?: DeferredObjectivePlanRevisionBus;
  rebuildPlan?: ReturnType<typeof vi.fn>;
}): { deps: FlowCardDeps; mock: ReturnType<typeof createMockHomey> } => {
  const mock = createMockHomey();
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
    rebuildPlan: overrides.rebuildPlan ?? vi.fn(),
    evaluateHeadroomForDevice: () => null,
    loadDailyBudgetSettings: () => {},
    updateDailyBudgetState: () => {},
    getCombinedHourlyPrices: () => null,
    getTimeZone: () => 'UTC',
    getNow: () => new Date(MOCK_NOW_MS),
    getStructuredLogger: () => undefined,
    log: () => {},
    logDebug: () => {},
    error: () => {},
    getDeferredObjectiveStatusBus: () => overrides.bus,
    getDeferredObjectivePlanRevisionBus: () => overrides.planRevisionBus,
  } as unknown as FlowCardDeps;
  return { deps, mock };
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

    const stored = mock.settings.get('deferred_objectives') as DeferredObjectiveSettingsV1;
    expect(stored.objectivesByDeviceId['heater-1']).toEqual({
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
    const stored = mock.settings.get('deferred_objectives') as DeferredObjectiveSettingsV1;
    expect(stored.objectivesByDeviceId['ev-1']).toEqual({
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
    const stored = mock.settings.get('deferred_objectives') as DeferredObjectiveSettingsV1;
    expect(stored.objectivesByDeviceId['ev-1']?.enforcement).toBe('soft');
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

  it('clear_deadline forgets the bus snapshot before rebuilding the plan', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const rebuildPlan = vi.fn(() => {
      expect(bus.hasActive('heater-1')).toBe(false);
    });
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
    mock.settings.set('deferred_objectives', {
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
    });
    registerDeadlineObjectiveCards(deps);
    await mock.actions.get('clear_deadline')!.run!({ device: 'heater-1' });
    expect(rebuildPlan).toHaveBeenCalledWith('deadline_objective_card_clear');
    expect(bus.hasActive('heater-1')).toBe(false);
  });

  it('calls applyDeferredObjectiveChange with prev/next entries on set_temperature_deadline', async () => {
    const applyChange = vi.fn();
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
    (deps as { applyDeferredObjectiveChange?: unknown }).applyDeferredObjectiveChange = applyChange;
    mock.settings.set('deferred_objectives', initial);
    registerDeadlineObjectiveCards(deps);
    await mock.actions.get('set_temperature_deadline')!.run!({
      device: 'heater-1', target_c: 60, ready_by: '08:00',
    });
    expect(applyChange).toHaveBeenCalledTimes(1);
    const call = applyChange.mock.calls[0]![0];
    expect(call.deviceId).toBe('heater-1');
    expect(call.prevEntry?.targetTemperatureC).toBe(55);
    expect(call.nextEntry?.targetTemperatureC).toBe(60);
    expect(call.nextEntry?.deadlineAtMs).toBe(HH_MM_TO_UTC_MS(8, 0));
  });

  it('calls applyDeferredObjectiveChange with cleared next entry on clear_deadline', async () => {
    const applyChange = vi.fn();
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
    (deps as { applyDeferredObjectiveChange?: unknown }).applyDeferredObjectiveChange = applyChange;
    mock.settings.set('deferred_objectives', initial);
    registerDeadlineObjectiveCards(deps);
    await mock.actions.get('clear_deadline')!.run!({ device: 'heater-1' });
    expect(applyChange).toHaveBeenCalledTimes(1);
    const call = applyChange.mock.calls[0]![0];
    expect(call.deviceId).toBe('heater-1');
    expect(call.prevEntry?.targetTemperatureC).toBe(55);
    expect(call.nextEntry).toBeUndefined();
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
    mock.settings.set('deferred_objectives', initial);
    registerDeadlineObjectiveCards(deps);
    const card = mock.actions.get('clear_deadline')!;
    await card.run!({ device: 'heater-1' });
    const stored = mock.settings.get('deferred_objectives') as DeferredObjectiveSettingsV1;
    expect(stored.objectivesByDeviceId).toEqual({});
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
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;
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
    expect(await condition.run!({ device: 'heater-1', status: 'at_risk' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'on_track' })).toBe(false);
    expect(await condition.run!({ device: 'heater-1', status: 'unachievable' })).toBe(false);
  });

  it('deadline_status_is returns true for waiting when a task has no status yet', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;
    mock.settings.set('deferred_objectives', {
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
    });
    expect(await condition.run!({ device: 'heater-1', status: 'waiting' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'pending_prices' })).toBe(true);
  });

  it('deadline_status_is maps compatibility status args to active smart task statuses', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;
    const snapshot: DeferredObjectiveStatusSnapshot = {
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'cannot_meet',
      previousStatus: 'on_track',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: false,
      shortfallKwh: null,
      shortfallText: null,
    };
    bus.publish(snapshot);

    expect(await condition.run!({ device: 'heater-1', status: 'unachievable' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'cannot_finish' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'missed' })).toBe(false);

    bus.publish({
      ...snapshot,
      status: 'satisfied',
      previousStatus: 'cannot_meet',
    });
    expect(await condition.run!({ device: 'heater-1', status: 'satisfied' })).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'done' })).toBe(true);
  });

  it('deadline_status_is preserves the legacy none status for cleared tasks', async () => {
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
    });
    registerDeadlineObjectiveCards(deps);
    const condition = mock.conditions.get('deadline_status_is')!;

    mock.settings.set('deferred_objectives', createEmptyDeferredObjectiveSettings());
    expect(await condition.run!({ device: 'heater-1', status: 'none' })).toBe(true);

    mock.settings.set('deferred_objectives', {
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
    });
    expect(await condition.run!({ device: 'heater-1', status: 'none' })).toBe(false);
  });

  it('publishes triggers for at-risk status transitions filtered by device and status args', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;
    const transition: DeferredObjectiveStatusSnapshot = {
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
    };
    bus.publish(transition);
    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    let [tokens, state] = trigger.trigger.mock.calls[0]!;
    expect(tokens).toMatchObject({ device_name: 'Boiler', status: 'At risk', kind: 'temperature' });
    expect(state).toEqual({ deviceId: 'heater-1', status: 'at_risk' });
    expect(await trigger.run!({ device: 'heater-1', status: { id: 'at_risk' } }, state)).toBe(true);
    expect(await trigger.run!({ device: 'heater-1', status: { id: 'on_track' } }, state)).toBe(false);

    bus.publish({
      ...transition,
      status: 'on_track',
      previousStatus: 'at_risk',
    });
    expect(trigger.trigger).toHaveBeenCalledTimes(2);
    [tokens, state] = trigger.trigger.mock.calls[1]!;
    expect(tokens).toMatchObject({ device_name: 'Boiler', status: 'On track', kind: 'temperature' });
    expect(state).toEqual({ deviceId: 'heater-1', status: 'on_track' });
    expect(await trigger.run!({ device: 'heater-1', status: { id: 'on_track' } }, state)).toBe(true);

    bus.publish({
      ...transition,
      status: 'cannot_meet',
      previousStatus: 'on_track',
    });
    expect(trigger.trigger).toHaveBeenCalledTimes(3);
    [tokens, state] = trigger.trigger.mock.calls[2]!;
    expect(tokens).toMatchObject({ device_name: 'Boiler', status: 'Cannot finish', kind: 'temperature' });
    expect(state).toEqual({ deviceId: 'heater-1', status: 'unachievable' });
    expect(await trigger.run!({ device: 'heater-1', status: { id: 'unachievable' } }, state)).toBe(true);
    expect(await trigger.run!({ device: 'heater-1', status: { id: 'cannot_finish' } }, state)).toBe(true);
    expect(await trigger.run!({ device: 'heater-1', status: { id: 'on_track' } }, state)).toBe(false);
    expect(await trigger.run!({ device: 'heater-2', status: { id: 'unachievable' } }, state)).toBe(false);
  });

  it('publishes unknown as waiting when the active smart task status changes', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;
    bus.publish({
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'unknown',
      previousStatus: 'on_track',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: false,
      shortfallKwh: null,
      shortfallText: null,
    });

    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    const [tokens, state] = trigger.trigger.mock.calls[0]!;
    expect(tokens).toMatchObject({ device_name: 'Boiler', status: 'Waiting', kind: 'temperature' });
    expect(state).toEqual({ deviceId: 'heater-1', status: 'waiting' });
  });

  it('does not fire on the first observation of a freshly created task', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;
    const snapshot: DeferredObjectiveStatusSnapshot = {
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'on_track',
      // `previousStatus = 'none'` means the bus had no record before — i.e. a
      // freshly added (or re-added after `clear_deadline`) task. The trigger
      // is "status changed", not "task created", so this must not fire.
      previousStatus: 'none',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: false,
      shortfallKwh: null,
      shortfallText: null,
    };

    bus.publish(snapshot);
    expect(trigger.trigger).not.toHaveBeenCalled();

    // Subsequent real status change (now bus has prior status `on_track`).
    bus.publish({
      ...snapshot,
      status: 'at_risk',
      previousStatus: 'on_track',
    });
    expect(trigger.trigger).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the bus forgets a device but the cache still holds the same deadline', () => {
    // Regression: `statusBus.forgetDevice()` is called from paths other than
    // `clear_deadline` (transition sweeps, runtime disable in appInit). Those
    // paths leave `lastFlowStatusByDeviceId` populated. When the device next
    // reappears with `previousStatus: 'none'` AND the cached entry happens to
    // match the same deadlineAtMs, the trigger would otherwise reuse the
    // stale cached status and emit a spurious status-change event.
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
      rebuildPlan: vi.fn(),
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;

    // Initial: bus publishes on_track with a real prior status — fires once
    // and populates the cache.
    const snapshot: DeferredObjectiveStatusSnapshot = {
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'on_track',
      previousStatus: 'unknown',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: false,
      shortfallKwh: null,
      shortfallText: null,
    };
    bus.publish(snapshot);
    expect(trigger.trigger).toHaveBeenCalledTimes(1);

    // Bus forgets the device via a non-clear path (e.g. transition sweep).
    // The trigger's cache is NOT cleared by this path.
    bus.forgetDevice('heater-1');

    // Re-publish with the same deadlineAtMs and previousStatus=none. Without
    // the fix, the cache match would suppress the 'none' signal and re-fire.
    bus.publish({ ...snapshot, previousStatus: 'none' });
    expect(trigger.trigger).toHaveBeenCalledTimes(1);
  });

  it('does not fire after clear_deadline + re-add even when the bus reports the same status', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
      rebuildPlan: vi.fn(),
    });
    mock.settings.set('deferred_objectives', {
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
    });
    registerDeadlineObjectiveCards(deps);
    const trigger = mock.triggers.get('deadline_status_changed')!;

    // First create: bus publishes on_track with a real prior status — fires.
    bus.publish({
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'on_track',
      previousStatus: 'unknown',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: false,
      shortfallKwh: null,
      shortfallText: null,
    });
    expect(trigger.trigger).toHaveBeenCalledTimes(1);

    // Clear via the action — wipes the bus and the trigger's cache.
    await mock.actions.get('clear_deadline')!.run!({ device: 'heater-1' });

    // Re-add at a different deadline time. Bus publishes with no prior
    // status; the now-empty cache must NOT fall back to firing because a
    // recreate is task creation, not a status change.
    bus.publish({
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'on_track',
      previousStatus: 'none',
      targetText: '55 °C',
      deadlineLocalTime: '08:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(8, 0),
      deadlineMissed: false,
      shortfallKwh: null,
      shortfallText: null,
    });
    expect(trigger.trigger).toHaveBeenCalledTimes(1);
  });

  it('publishes missed through the legacy missed trigger, not active status', async () => {
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
    });
    registerDeadlineObjectiveCards(deps);
    const statusTrigger = mock.triggers.get('deadline_status_changed')!;
    const missedTrigger = mock.triggers.get('deadline_missed')!;
    const condition = mock.conditions.get('deadline_status_is')!;
    const transition: DeferredObjectiveStatusSnapshot = {
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'cannot_meet',
      previousStatus: 'on_track',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: true,
      shortfallKwh: 1.2,
      shortfallText: '5 °C below target',
    };
    bus.publishMissed(transition);

    expect(statusTrigger.trigger).not.toHaveBeenCalled();
    expect(missedTrigger.trigger).toHaveBeenCalledTimes(1);
    const [tokens, state] = missedTrigger.trigger.mock.calls[0]!;
    expect(tokens).toMatchObject({
      device_name: 'Boiler',
      kind: 'temperature',
      shortfall_kwh: 1.2,
      shortfall_text: '5 °C below target',
    });
    expect(state).toEqual({ deviceId: 'heater-1' });
    expect(await missedTrigger.run!({ device: 'heater-1' }, state)).toBe(true);
    expect(await condition.run!({ device: 'heater-1', status: 'missed' })).toBe(false);
    expect(await condition.run!({ device: 'heater-1', status: 'unachievable' })).toBe(false);

    bus.publish({
      ...transition,
      status: 'cannot_meet',
      previousStatus: 'on_track',
    });
    expect(statusTrigger.trigger).not.toHaveBeenCalled();

    bus.publishMissed({
      ...transition,
      deadlineAtMs: HH_MM_TO_UTC_MS(8, 0),
      deadlineLocalTime: '08:00',
    });
    expect(missedTrigger.trigger).toHaveBeenCalledTimes(2);
  });

  it('emits an empty shortfall_text when the device-side shortfall is unknown', () => {
    const bus = createDeferredObjectiveStatusBus();
    const { deps, mock } = buildDeps({
      snapshot: [buildDevice({ id: 'heater-1', name: 'Boiler', deviceType: 'temperature' })],
      bus,
    });
    registerDeadlineObjectiveCards(deps);
    const missedTrigger = mock.triggers.get('deadline_missed')!;
    bus.publishMissed({
      deviceId: 'heater-1',
      deviceName: 'Boiler',
      kind: 'temperature',
      status: 'cannot_meet',
      previousStatus: 'on_track',
      targetText: '55 °C',
      deadlineLocalTime: '07:00',
      deadlineAtMs: HH_MM_TO_UTC_MS(7, 0),
      deadlineMissed: true,
      // Unknown shortfall: the Homey SDK rejects `null` for `number`-typed
      // tokens, so the numeric token still falls back to `0` and flows are
      // expected to gate "unknown" via the (empty) `shortfall_text` instead.
      shortfallKwh: null,
      shortfallText: null,
    });
    const [tokens] = missedTrigger.trigger.mock.calls[0]!;
    expect(tokens.shortfall_text).toBe('');
    expect(tokens.shortfall_kwh).toBe(0);
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
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'prices_revised',
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
    expect(tokens).toMatchObject({
      device_name: 'Garage charger',
      remaining_kwh: 6.5,
      planned_hours: 3,
      projected_finish_local_time: '05:36',
    });
    expect(tokens).not.toHaveProperty('projected_finish_at_ms');
    expect(state).toEqual({ deviceId: 'ev-1' });
    expect(await trigger.run!({ device: 'ev-1' }, state)).toBe(true);
    expect(await trigger.run!({ device: 'ev-2' }, state)).toBe(false);

    // allocationChanged === false should not fire the trigger.
    planRevisionBus.publish({
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'rate_refined',
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
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'prices_revised',
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
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'prices_revised',
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
      deviceId: 'ev-1',
      deviceName: 'Garage charger',
      objectiveKind: 'ev_soc',
      reason: 'prices_revised',
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

    mock.settings.set('deferred_objectives', createEmptyDeferredObjectiveSettings());
    expect(await condition.run!({ device: 'heater-1' })).toBe(false);

    mock.settings.set('deferred_objectives', {
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
    });
    expect(await condition.run!({ device: 'heater-1' })).toBe(true);
  });
});
