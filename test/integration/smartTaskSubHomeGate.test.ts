// Integration coverage for the multi-home v1 smart-task scope gate
// (`device_in_sub_home` / `objective_device_in_sub_home`):
// - the device-scoped write op refuses an UPSERT for a sub-home device with the
//   typed reason (no write, no notify/rebuild) while clear stays ungated, and
//   behaves identically when the membership dep is absent or resolves main;
// - the diagnostics bridge resolves an EXISTING task whose device is in a
//   sub-home to the dedicated `objective_device_in_sub_home` unknown code —
//   never the misleading `objective_missing_device` — and admission then treats
//   the task as inactive (it never governs the device);
// - the decoration controller threads its `isDeviceInSubHome` dep into the
//   per-cycle evaluation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockSettings } from '../mocks/homey';
import { updateSettingsUiSmartTask } from '../../setup/settingsUiSmartTaskApi';
import { handleDeferredDeadlineReached } from '../../setup/appInit/deferredObjectiveLifecycle';
import {
  buildStarvedRescueDevices,
  hasMainHomeSmartTaskAuthority,
  isSmartTaskDeviceInMainHome,
  readCreateSmartTaskCandidateDevices,
  resolveSmartTaskHomeScope,
} from '../../setup/appInit/smartTaskHomeScope';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { AppContext } from '../../lib/app/appContext';
import {
  ConcurrentEligibleTaskTracker,
  resolveConcurrentEligibleCount,
} from '../../lib/objectives/deferredObjectives/concurrentEligibleTasks';
import type { ObjectiveDeviceInput } from '../../lib/objectives/types';
import {
  buildDeferredObjectiveDiagnostics,
  DeferredObjectiveDecorationController,
  normalizeDeferredObjectiveSettings,
} from '../../lib/objectives/deferredObjectives';
import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import {
  clearObjectiveForDevice,
  upsertObjectiveForDevice,
  type DeferredObjectiveDeviceWriteDeps,
} from '../../lib/objectives/deferredObjectives/objectiveWrite';
import {
  PER_DEVICE_OBJECTIVE_KEY_PREFIX,
  readObjectiveForDevice,
  type ObjectiveSettingsStore,
} from '../../lib/objectives/deferredObjectives/objectiveStore';
import type { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from '../../lib/objectives/deferredObjectives/planHistory';
import type { DeferredObjectiveSettingsEntry } from '../../lib/objectives/deferredObjectives/settings';
import type { SmartTaskHomeScope } from '../../packages/contracts/src/smartTaskHomeScope';
import {
  withBinaryDiscriminant,
  withTemperatureDiscriminant,
  type PlanInputDevice,
} from '../../lib/plan/planTypes';
import {
  createPendingBinaryCommandStore,
  syncPendingBinaryCommands,
} from '../../lib/observer/pendingBinaryCommands';

const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const DEADLINE_MS = NOW_MS + 6 * 60 * 60 * 1000;

const heaterEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 60,
  deadlineAtMs: DEADLINE_MS,
};

const keyFor = (deviceId: string): string => `${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${deviceId}`;

// In-memory store standing in for `homey.settings` (structurally an
// ObjectiveSettingsStore); a non-objective key keeps getKeys() non-empty as a
// real PELS store always is (the trustworthy-absence guard relies on this).
const buildStore = (
  seed: Record<string, DeferredObjectiveSettingsEntry> = {},
): ObjectiveSettingsStore & { raw: Map<string, unknown> } => {
  const raw = new Map<string, unknown>();
  raw.set('capacity_limit_kw', 5);
  for (const [deviceId, entry] of Object.entries(seed)) raw.set(keyFor(deviceId), entry);
  return {
    raw,
    get: (key) => raw.get(key),
    set: (key, value) => { raw.set(key, value); },
    unset: (key) => { raw.delete(key); },
    getKeys: () => [...raw.keys()],
  };
};

const buildDeviceDeps = (
  store: ObjectiveSettingsStore,
  resolveDeviceHomeScope?: (deviceId: string) => SmartTaskHomeScope,
) => {
  const activePlanRecorder = {
    markPending: vi.fn(),
    clearForDevice: vi.fn(),
    flushIfDirty: vi.fn(),
  } as unknown as DeferredObjectiveActivePlanRecorder;
  const planHistoryRecorder = {
    finalizeForUserChange: vi.fn(),
    finalizeElapsedDeadline: vi.fn(),
    flushIfDirty: vi.fn(),
  } as unknown as DeferredObjectivePlanHistoryRecorder;
  const rebuildPlan = vi.fn();
  const debugStructured = vi.fn();
  const deps: DeferredObjectiveDeviceWriteDeps = {
    store,
    activePlanRecorder,
    planHistoryRecorder,
    rebuildPlan,
    nowMs: NOW_MS,
    ...(resolveDeviceHomeScope ? { resolveDeviceHomeScope } : {}),
    debugStructured,
  };
  return { deps, activePlanRecorder, planHistoryRecorder, rebuildPlan, debugStructured };
};

describe('device-scoped write op: sub-home gate', () => {
  it('upsert refuses a sub-home device with the typed reason — no write, no notify/rebuild', () => {
    const store = buildStore();
    const h = buildDeviceDeps(store, (deviceId) => (
      deviceId === 'heater-sub' ? 'sub_home' : 'main'
    ));
    const outcome = upsertObjectiveForDevice(h.deps, {
      deviceId: 'heater-sub',
      deviceName: 'Cabin heater',
      entry: heaterEntry,
    });
    expect(outcome).toEqual({ persisted: false, reason: 'device_in_sub_home' });
    expect(readObjectiveForDevice(store, 'heater-sub')).toBeUndefined();
    expect(h.activePlanRecorder.markPending).not.toHaveBeenCalled();
    expect(h.rebuildPlan).not.toHaveBeenCalled();
    // The refusal leaves a topic-gated debug breadcrumb like the transient ones.
    expect(h.debugStructured).toHaveBeenCalledWith({
      event: 'objective_write_refused',
      op: 'upsert',
      deviceId: 'heater-sub',
      reason: 'device_in_sub_home',
    });
  });

  it('upsert persists unchanged for a main-home device and when the dep is absent (single-home identity)', () => {
    const gatedStore = buildStore();
    const gated = buildDeviceDeps(gatedStore, () => 'main');
    expect(upsertObjectiveForDevice(gated.deps, {
      deviceId: 'heater-main', deviceName: 'Hall heater', entry: heaterEntry,
    })).toEqual({ persisted: true });
    expect(readObjectiveForDevice(gatedStore, 'heater-main')).toEqual(heaterEntry);

    const bareStore = buildStore();
    const bare = buildDeviceDeps(bareStore);
    expect(upsertObjectiveForDevice(bare.deps, {
      deviceId: 'heater-main', deviceName: 'Hall heater', entry: heaterEntry,
    })).toEqual({ persisted: true });
    expect(readObjectiveForDevice(bareStore, 'heater-main')).toEqual(heaterEntry);
  });

  it('clear stays UNGATED: a task on a device relocated to a sub-home can still be removed', () => {
    const store = buildStore({ 'heater-sub': heaterEntry });
    const h = buildDeviceDeps(store, () => 'sub_home');
    const outcome = clearObjectiveForDevice(h.deps, { deviceId: 'heater-sub', deviceName: 'Cabin heater' });
    expect(outcome).toEqual({ persisted: true });
    expect(readObjectiveForDevice(store, 'heater-sub')).toBeUndefined();
  });

  it('upsert refuses provisional authority as retryable ownership_unavailable', () => {
    const store = buildStore();
    const h = buildDeviceDeps(store, () => 'unavailable');
    const outcome = upsertObjectiveForDevice(h.deps, {
      deviceId: 'heater-main',
      deviceName: 'Hall heater',
      entry: heaterEntry,
    });
    expect(outcome).toEqual({ persisted: false, reason: 'ownership_unavailable' });
    expect(readObjectiveForDevice(store, 'heater-main')).toBeUndefined();
    expect(h.rebuildPlan).not.toHaveBeenCalled();
    expect(h.debugStructured).toHaveBeenCalledWith({
      event: 'objective_write_refused',
      op: 'upsert',
      deviceId: 'heater-main',
      reason: 'ownership_unavailable',
    });
  });

  it('upsert durably refuses an active meter source as device_not_planned', () => {
    const store = buildStore();
    const h = buildDeviceDeps(store, () => 'source_device');
    const outcome = upsertObjectiveForDevice(h.deps, {
      deviceId: 'meter-main',
      deviceName: 'Whole-home meter',
      entry: heaterEntry,
    });
    expect(outcome).toEqual({ persisted: false, reason: 'device_not_planned' });
    expect(readObjectiveForDevice(store, 'meter-main')).toBeUndefined();
    expect(h.rebuildPlan).not.toHaveBeenCalled();
    expect(h.debugStructured).toHaveBeenCalledWith({
      event: 'objective_write_refused',
      op: 'upsert',
      deviceId: 'meter-main',
      reason: 'device_not_planned',
    });
  });
});

// ─── Diagnostics honesty for an existing task on a relocated device ──────────

const buildHeaterDevice = (): PlanInputDevice => withTemperatureDiscriminant(withBinaryDiscriminant({ currentDrawKw: 0,
  id: 'heater-sub',
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Cabin heater',
  commandableNow: true,
  targets: [{ id: 'target_temperature', value: 55, unit: 'C', min: 0, max: 95, step: 0.5 }],
  binaryControl: { on: false },
  deviceType: 'temperature' as const,
  controlCapabilityId: 'onoff' as const,
  currentTemperature: 40,
  lastFreshDataMs: NOW_MS,
})) as PlanInputDevice;

const buildDiagnosticsParams = (overrides: {
  devices: PlanInputDevice[];
  isDeviceInSubHome?: (deviceId: string) => boolean;
}) => ({
  nowMs: NOW_MS,
  timeZone: 'UTC',
  devices: overrides.devices,
  settings: normalizeDeferredObjectiveSettings({
    version: 1,
    objectivesByDeviceId: { 'heater-sub': heaterEntry },
  }),
  powerTracker: { lastTimestamp: NOW_MS },
  dailyBudgetSnapshot: null,
  buildPriceHorizon: () => [],
  priceOptimizationEnabled: true,
  ...(overrides.isDeviceInSubHome ? { isDeviceInSubHome: overrides.isDeviceInSubHome } : {}),
});

describe('diagnostics: existing task whose device is in a sub-home', () => {
  it('resolves the dedicated objective_device_in_sub_home unknown code when the device is present', () => {
    const diagnostics = buildDeferredObjectiveDiagnostics(buildDiagnosticsParams({
      devices: [buildHeaterDevice()],
      isDeviceInSubHome: (deviceId) => deviceId === 'heater-sub',
    }));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].trajectory).toEqual({
      kind: 'unavailable',
      reasonCode: 'objective_device_in_sub_home',
    });
    expect(diagnostics[0].reasonCode).toBe('objective_device_in_sub_home');
  });

  it('beats the misleading objective_missing_device even when main-only planner scoping dropped the device', () => {
    const diagnostics = buildDeferredObjectiveDiagnostics(buildDiagnosticsParams({
      devices: [],
      isDeviceInSubHome: () => true,
    }));
    expect(diagnostics[0].reasonCode).toBe('objective_device_in_sub_home');
  });

  it('without the predicate (no sub-homes) the diagnostic never carries the sub-home code', () => {
    const diagnostics = buildDeferredObjectiveDiagnostics(buildDiagnosticsParams({
      devices: [buildHeaterDevice()],
    }));
    expect(diagnostics[0].reasonCode).not.toBe('objective_device_in_sub_home');
  });

  it('admission treats the sub-home diagnostic as inactive — the task never governs the device', () => {
    const devices = [buildHeaterDevice()];
    const diagnostics = buildDeferredObjectiveDiagnostics(buildDiagnosticsParams({
      devices,
      isDeviceInSubHome: () => true,
    }));
    const decisions = applyDeferredObjectiveAdmission(diagnostics, devices);
    expect(decisions.get('heater-sub')?.kind).toBe('inactive');
  });
});

// ─── Settings-UI smart-task edit lane (its own validation path) ─────────────
//
// The settings-UI surface is edit-only (`gateEditableTask` requires an
// existing task) and applies the same public main-home membership predicate
// before calling the create engine. Cover it end-to-lane so a sub-home
// rejection reaches the editor typed, never collapsed into
// `invalid_candidate`, and no stale task update is attempted.
describe('settings-UI smart-task edit lane: sub-home rejection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('update rejects through the shared membership gate before calling the create engine', () => {
    const settings = new MockSettings();
    settings.set('capacity_limit_kw', 10);
    // Existing, enabled, future-deadline task — the device moved to a sub-home
    // AFTER creation, so the edit gate passes and the membership gate rejects.
    settings.set('deferred_objective.heater-sub', heaterEntry);
    const createDeferredObjective = vi.fn(() => ({ ok: true as const }));
    const homey = {
      app: {
        createDeferredObjective,
        resolveSmartTaskHomeScope: (deviceId: string) => (
          deviceId === 'heater-sub' ? 'sub_home' : 'main'
        ),
      },
      clock: { getTimezone: () => 'UTC' },
      settings,
    } as never;
    const result = updateSettingsUiSmartTask({
      homey,
      body: { deviceId: 'heater-sub', kind: 'temperature', target: 65, readyByLocalTime: '17:00' },
    });
    expect(createDeferredObjective).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: 'device_in_sub_home' });
  });

  it('update rejects through the producer gate while Main ownership is unresolved', () => {
    const settings = new MockSettings();
    settings.set('capacity_limit_kw', 10);
    settings.set('deferred_objective.heater-sub', heaterEntry);
    const createDeferredObjective = vi.fn(() => ({ ok: true as const }));
    const ctx = createAppContextMock({
      homeMembership: {
        getHomeIdForDevice: () => 'main',
        isOwnershipReady: () => true,
        hasPendingOwnershipGeneration: () => false,
        isMainHomeActuationFenced: () => true,
        getConfiguredMeterSources: () => ({ state: 'resolved', deviceIds: new Set() }),
      } as unknown as AppContext['homeMembership'],
    });
    const homey = {
      app: {
        createDeferredObjective,
        resolveSmartTaskHomeScope: (deviceId: string) => resolveSmartTaskHomeScope(ctx, deviceId),
      },
      clock: { getTimezone: () => 'UTC' },
      settings,
    } as never;

    expect(updateSettingsUiSmartTask({
      homey,
      body: { deviceId: 'heater-sub', kind: 'temperature', target: 65, readyByLocalTime: '17:00' },
    })).toEqual({ ok: false, reason: 'unavailable' });
    expect(createDeferredObjective).not.toHaveBeenCalled();
  });
});

// ─── Membership predicate fail-safes ─────────────────────────────────────────
describe('smart-task membership and authority predicates', () => {
  const ctxWithHomeId = (
    homeId: unknown,
    fenced = false,
    meterDeviceIds = new Set<string>(),
  ) => createAppContextMock({
    homeMembership: {
      getHomeIdForDevice: () => homeId,
      isOwnershipReady: () => homeId !== null && homeId !== undefined,
      hasPendingOwnershipGeneration: () => false,
      isMainHomeActuationFenced: () => fenced,
      getConfiguredMeterSources: () => ({
        state: 'resolved',
        deviceIds: meterDeviceIds,
      }),
    } as unknown as AppContext['homeMembership'],
  });

  it('keeps provisional membership distinct from authority', () => {
    expect(isSmartTaskDeviceInMainHome(ctxWithHomeId('main'), 'd1')).toBe(true);
    expect(isSmartTaskDeviceInMainHome(ctxWithHomeId('main', true), 'd1')).toBe(true);
    expect(hasMainHomeSmartTaskAuthority(ctxWithHomeId('main', true), 'd1')).toBe(false);
    expect(resolveSmartTaskHomeScope(ctxWithHomeId('main', true), 'd1')).toBe('unavailable');
    expect(isSmartTaskDeviceInMainHome(ctxWithHomeId(null), 'd1')).toBe(true);
    expect(isSmartTaskDeviceInMainHome(createAppContextMock({}), 'd1')).toBe(true);
    expect(hasMainHomeSmartTaskAuthority(createAppContextMock({}), 'd1')).toBe(false);
    expect(resolveSmartTaskHomeScope(createAppContextMock({}), 'd1')).toBe('unavailable');
    expect(isSmartTaskDeviceInMainHome(ctxWithHomeId('h_cabin'), 'd1')).toBe(false);
    expect(hasMainHomeSmartTaskAuthority(ctxWithHomeId('h_cabin'), 'd1')).toBe(false);
    expect(resolveSmartTaskHomeScope(ctxWithHomeId('h_cabin'), 'd1')).toBe('sub_home');
  });

  it('excludes a configured meter from smart-task authority and candidates', () => {
    const ctx = ctxWithHomeId('main', false, new Set(['meter-1']));
    ctx.latestTargetSnapshot.push({
      id: 'meter-1',
      name: 'Main meter',
      managed: true,
    } as AppContext['latestTargetSnapshot'][number]);
    ctx.latestTargetSnapshot.push({
      id: 'heater-1',
      name: 'Hall heater',
      managed: true,
    } as AppContext['latestTargetSnapshot'][number]);

    expect(resolveSmartTaskHomeScope(ctx, 'meter-1')).toBe('source_device');
    expect(hasMainHomeSmartTaskAuthority(ctx, 'meter-1')).toBe(false);
    expect(readCreateSmartTaskCandidateDevices(ctx)).toEqual({
      state: 'ready',
      devices: [expect.objectContaining({ id: 'heater-1' })],
    });
  });

  it('keeps authoritative source identity durable across sub-home membership and a Main collision fence', () => {
    expect(resolveSmartTaskHomeScope(
      ctxWithHomeId('h_cabin', false, new Set(['meter-1'])),
      'meter-1',
    )).toBe('source_device');
    expect(resolveSmartTaskHomeScope(
      ctxWithHomeId('main', true, new Set(['meter-1'])),
      'meter-1',
    )).toBe('source_device');
  });

  it('keeps a Main held-back row visible while transient authority disables rescue', () => {
    const ctx = createAppContextMock({
      homeMembership: {
        getHomeIdForDevice: () => 'main',
        isOwnershipReady: () => true,
        hasPendingOwnershipGeneration: () => false,
        isMainHomeActuationFenced: () => true,
        getConfiguredMeterSources: () => ({ state: 'resolved', deviceIds: new Set() }),
      } as unknown as AppContext['homeMembership'],
      latestTargetSnapshot: [{
        id: 'd1',
        expectedPowerKw: 1, expectedPowerSource: 'default',
        name: 'Hall heater',
        targets: [],
        binaryControl: { on: false },
      }],
      deviceDiagnosticsService: {
        getStarvedRescueEntries: () => [{
          deviceId: 'd1',
          starvation: { isStarved: true, accumulatedMs: 20 * 60_000 },
          intendedNormalTargetC: 60,
        }],
      } as unknown as AppContext['deviceDiagnosticsService'],
    });

    expect(buildStarvedRescueDevices(ctx)).toEqual([
      expect.objectContaining({
        deviceId: 'd1',
        smartTaskHomeScope: 'unavailable',
      }),
    ]);
  });

  it('omits an active meter source from held-back rescue rows', () => {
    const ctx = ctxWithHomeId('main', false, new Set(['meter-1']));
    ctx.latestTargetSnapshot.push({
      id: 'meter-1',
      expectedPowerKw: 1, expectedPowerSource: 'default',
      name: 'Whole-home meter',
      managed: true,
      targets: [],
      binaryControl: { on: false },
    } as AppContext['latestTargetSnapshot'][number]);
    ctx.deviceDiagnosticsService = {
      getStarvedRescueEntries: () => [{
        deviceId: 'meter-1',
        starvation: { isStarved: true, accumulatedMs: 20 * 60_000 },
        intendedNormalTargetC: 60,
      }],
    } as unknown as AppContext['deviceDiagnosticsService'];

    expect(buildStarvedRescueDevices(ctx)).toEqual([]);
  });
});

// ─── Terminal-release (lifecycle) lane: no wrong-meter actuation ─────────────
//
// The clock-driven deadline ending returns a cap-off device to its fallback
// posture via the transport. A device relocated to a sub-home is outside
// PELS's main-home control scope, so the terminal command must be suppressed
// and the task must end via the same immediate-disarm path as cap-on.
describe('handleDeferredDeadlineReached: sub-home device gets no terminal actuation', () => {
  const DEADLINE = 1_000_000;

  const buildLifecycleCtx = (
    homeIdForDevice: string,
    initiallyFenced = false,
    meterDeviceIds = new Set<string>(),
  ) => {
    const settingsStore = new Map<string, unknown>([
      ['deferred_objective.d1', {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 21,
        deadlineAtMs: DEADLINE,
      }],
    ]);
    const forgetDevice = vi.fn();
    const setCapability = vi.fn().mockResolvedValue(undefined);
    const applyDeviceTargets = vi.fn().mockResolvedValue(undefined);
    const pendingBinaryCommandStore = createPendingBinaryCommandStore({});
    let fenced = initiallyFenced;
    let deviceOn = true;
    const homey = {
      settings: {
        get: vi.fn((key: string) => settingsStore.get(key)),
        set: vi.fn((key: string, value: unknown) => { settingsStore.set(key, value); }),
        unset: vi.fn((key: string) => { settingsStore.delete(key); }),
        getKeys: vi.fn(() => [...settingsStore.keys()]),
        on: vi.fn(),
        off: vi.fn(),
      },
    } as unknown as AppContext['homey'];
    const ctx = createAppContextMock({
      homey,
      isCapacityControlEnabled: () => false, // cap-off → terminal release lane
      homeMembership: {
        getHomeIdForDevice: () => homeIdForDevice,
        isOwnershipReady: () => true,
        hasPendingOwnershipGeneration: () => false,
        isMainHomeActuationFenced: () => fenced,
        getConfiguredMeterSources: () => ({
          state: 'resolved',
          deviceIds: meterDeviceIds,
        }),
      } as unknown as AppContext['homeMembership'],
      deviceManager: { setCapability, applyDeviceTargets } as unknown as AppContext['deviceManager'],
      planEngine: {
        pendingBinaryCommandStore,
      } as unknown as AppContext['planEngine'],
      // Present, available, ON binary device — the exact fixture that WOULD
      // actuate a binary-off terminal release without the sub-home gate (the
      // control test below proves it).
      planService: {
        getPlanDevices: () => [withBinaryDiscriminant({ currentDrawKw: 0,
          id: 'd1',
          expectedPowerKw: 1, expectedPowerSource: 'default',
          name: 'Cabin heater',
          commandableNow: true,
          available: true,
          controllable: true,
          controlCapabilityId: 'onoff',
          binaryControl: { on: deviceOn },
          targets: [],
        }) as PlanInputDevice],
      } as unknown as AppContext['planService'],
      deferredObjectiveStatusBus: { forgetDevice } as unknown as AppContext['deferredObjectiveStatusBus'],
      deferredObjectiveActivePlanRecorder: {
        clearForDevice: vi.fn(),
        getActivePlansSnapshot: () => ({ version: 1, plansByDeviceId: {} }),
      } as unknown as AppContext['deferredObjectiveActivePlanRecorder'],
    });
    return {
      ctx,
      settingsStore,
      forgetDevice,
      setCapability,
      applyDeviceTargets,
      pendingBinaryCommandStore,
      setFenced: (next: boolean) => { fenced = next; },
      setDeviceOn: (next: boolean) => { deviceOn = next; },
    };
  };

  // The terminal release is fire-and-forget (`void applyShedBehavior`), so
  // actuation assertions flush the microtask queue first.
  const settleActuation = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  const confirmTerminalOff = (
    store: ReturnType<typeof buildLifecycleCtx>['pendingBinaryCommandStore'],
  ): void => {
    const pending = store.peek('d1');
    if (!pending) throw new Error('terminal OFF is not pending');
    syncPendingBinaryCommands({
      store,
      liveDevices: [{
        id: 'd1',
        name: 'Cabin heater',
        binaryControlObservation: {
          capabilityId: 'onoff',
          observedValue: false,
          observedAtMs: pending.startedMs + 1,
          observedCapabilityIds: ['onoff'],
        },
      }],
      source: 'snapshot_refresh',
    });
  };

  it('control: a main-home device DOES receive the terminal release command', async () => {
    const h = buildLifecycleCtx('main');
    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 60_000);
    expect(h.pendingBinaryCommandStore.peek('d1')).toEqual(expect.objectContaining({
      capabilityId: 'onoff',
      desired: false,
      lifecycleRelease: true,
    }));
    await settleActuation();
    expect(h.setCapability).toHaveBeenCalled();
    expect(h.setCapability.mock.calls[0].slice(0, 3)).toEqual(['d1', 'onoff', false]);
    expect(h.pendingBinaryCommandStore.hasRecentConfirmedOff('d1', 'onoff')).toBe(false);
    confirmTerminalOff(h.pendingBinaryCommandStore);
    expect(h.pendingBinaryCommandStore.hasRecentConfirmedOff('d1', 'onoff')).toBe(true);
  });

  it('keeps terminal OFF pending until telemetry confirms it', async () => {
    const h = buildLifecycleCtx('main');
    let resolveWrite!: () => void;
    h.setCapability.mockImplementation(() => new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }));

    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 60_000);

    expect(h.pendingBinaryCommandStore.isBinaryChangeAttributableToPels('d1', 'onoff')).toBe(true);
    expect(h.pendingBinaryCommandStore.hasRecentConfirmedOff('d1', 'onoff')).toBe(false);

    resolveWrite();
    await settleActuation();

    expect(h.pendingBinaryCommandStore.hasRecentConfirmedOff('d1', 'onoff')).toBe(false);
    confirmTerminalOff(h.pendingBinaryCommandStore);
    expect(h.pendingBinaryCommandStore.hasRecentConfirmedOff('d1', 'onoff')).toBe(true);
  });

  it('does not let an older failed attempt clear newer terminal OFF attribution', async () => {
    const h = buildLifecycleCtx('main');
    const attempts: {
      resolve: () => void;
      reject: (error: Error) => void;
    }[] = [];
    h.setCapability.mockImplementation(() => new Promise<void>((resolve, reject) => {
      attempts.push({ resolve, reject });
    }));

    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 60_000);
    const firstPending = h.pendingBinaryCommandStore.peek('d1');
    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 90_000);
    const secondPending = h.pendingBinaryCommandStore.peek('d1');
    expect(secondPending).not.toBe(firstPending);

    attempts[0].reject(new Error('first attempt failed late'));
    await settleActuation();

    expect(h.pendingBinaryCommandStore.peek('d1')).toBe(secondPending);
    expect(h.pendingBinaryCommandStore.isBinaryChangeAttributableToPels('d1', 'onoff')).toBe(true);

    attempts[1].resolve();
    await settleActuation();
  });

  it('a sub-home device gets NO device command and the task ends via the immediate disarm', async () => {
    const h = buildLifecycleCtx('h_cabin');
    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 60_000);
    await settleActuation();
    // No wrong-meter actuation of any kind.
    expect(h.setCapability).not.toHaveBeenCalled();
    expect(h.applyDeviceTargets).not.toHaveBeenCalled();
    // Honest existing ending: disarmed immediately (cap-on-style), status forgotten.
    expect((h.settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
    expect(h.forgetDevice).toHaveBeenCalledWith('d1');
  });

  it('a configured meter gets no terminal command and its stale task disarms immediately', async () => {
    const h = buildLifecycleCtx('main', false, new Set(['d1']));

    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 60_000);
    await settleActuation();

    expect(h.setCapability).not.toHaveBeenCalled();
    expect(h.applyDeviceTargets).not.toHaveBeenCalled();
    expect((h.settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
    expect(h.forgetDevice).toHaveBeenCalledWith('d1');
  });

  it('a configured meter still disarms without a command during a Main collision fence', async () => {
    const h = buildLifecycleCtx('main', true, new Set(['d1']));

    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 60_000);
    await settleActuation();

    expect(h.setCapability).not.toHaveBeenCalled();
    expect(h.applyDeviceTargets).not.toHaveBeenCalled();
    expect((h.settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
    expect(h.forgetDevice).toHaveBeenCalledWith('d1');
  });

  it('retains a Main task without writes during a transient fence and retries after recovery', async () => {
    const h = buildLifecycleCtx('main', true);

    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 60_000);
    await settleActuation();
    expect(h.setCapability).not.toHaveBeenCalled();
    expect((h.settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(true);
    expect(h.forgetDevice).not.toHaveBeenCalled();
    // A global fence is not durable relocation and must not produce the
    // sub-home diagnostic predicate.
    expect(isSmartTaskDeviceInMainHome(h.ctx, 'd1')).toBe(true);
    expect(hasMainHomeSmartTaskAuthority(h.ctx, 'd1')).toBe(false);

    h.setFenced(false);
    handleDeferredDeadlineReached(
      h.ctx,
      'd1',
      'temperature',
      DEADLINE,
      DEADLINE + 2 * 60_000,
    );
    await settleActuation();
    expect(h.setCapability).toHaveBeenCalled();
    expect((h.settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(true);
    expect(h.forgetDevice).not.toHaveBeenCalled();

    // Once the next observation confirms the requested off posture, the next
    // pre-grace tick settles and disarms normally.
    h.setDeviceOn(false);
    handleDeferredDeadlineReached(
      h.ctx,
      'd1',
      'temperature',
      DEADLINE,
      DEADLINE + 2.5 * 60_000,
    );
    await settleActuation();
    expect((h.settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
    expect(h.forgetDevice).toHaveBeenCalledWith('d1');
  });

  it('gives up on a fence that outlives the grace window instead of retrying forever', async () => {
    const h = buildLifecycleCtx('main', true);

    // Inside the 5 min grace the fence is assumed transient: keep the task.
    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 60_000);
    await settleActuation();
    expect((h.settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(true);
    expect(h.forgetDevice).not.toHaveBeenCalled();

    // But a fence can also persist: a Main whole-home meter that is also a
    // meter area's meter holds it until the owner changes one of the two
    // selections. Without a grace bail the objective would stay enabled past
    // its deadline forever, never filing the run — unlike every sibling arm,
    // which gives up after the same grace. No actuation either way: the fence
    // exists precisely because a Main write cannot be trusted.
    handleDeferredDeadlineReached(h.ctx, 'd1', 'temperature', DEADLINE, DEADLINE + 6 * 60_000);
    await settleActuation();
    expect(h.setCapability).not.toHaveBeenCalled();
    expect(h.applyDeviceTargets).not.toHaveBeenCalled();
    expect((h.settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
    expect(h.forgetDevice).toHaveBeenCalledWith('d1');
  });
});

// ─── Concurrent-eligible denominator: relocated tasks stop diluting ──────────
describe('concurrent-eligible count: sub-home tasks leave the denominator immediately', () => {
  const reservedEntry = (deadlineAtMs: number): DeferredObjectiveSettingsEntry => ({
    enabled: true,
    kind: 'temperature',
    enforcement: 'soft',
    targetTemperatureC: 60,
    deadlineAtMs,
    rescue: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' },
  });
  const priorityOneDevice = (id: string): ObjectiveDeviceInput => (
    { id, name: id, priority: 1, targets: [] } as unknown as ObjectiveDeviceInput
  );
  const settings = normalizeDeferredObjectiveSettings({
    version: 1,
    objectivesByDeviceId: {
      'heater-sub': reservedEntry(NOW_MS + 6 * 60 * 60 * 1000),
      'heater-main': reservedEntry(NOW_MS + 6 * 60 * 60 * 1000),
    },
  });
  const deviceById = new Map<string, ObjectiveDeviceInput>([
    ['heater-sub', priorityOneDevice('heater-sub')],
    ['heater-main', priorityOneDevice('heater-main')],
  ]);

  it('excludes a sub-home reserved task from the tracker denominator', () => {
    const tracker = new ConcurrentEligibleTaskTracker();
    const count = resolveConcurrentEligibleCount({
      settings,
      deviceById,
      nowMs: NOW_MS,
      tracker,
      isDeviceInSubHome: (deviceId) => deviceId === 'heater-sub',
    });
    expect(typeof count).toBe('function');
    expect((count as (bucketStartMs: number) => number)(NOW_MS)).toBe(1);
  });

  it('prunes a pre-relocation entry IMMEDIATELY — membership is authoritative, no abandon grace', () => {
    const tracker = new ConcurrentEligibleTaskTracker();
    // Cycle 1: both tasks eligible (no sub-homes yet).
    tracker.observe({ settings, deviceById, nowMs: NOW_MS });
    expect(tracker.count({ nowMs: NOW_MS })).toBe(2);
    // Cycle 2, seconds later: the device was pinned into a sub-home. The old
    // entry must not linger for the SDK-flicker grace window.
    tracker.observe({
      settings,
      deviceById,
      nowMs: NOW_MS + 30_000,
      isDeviceInSubHome: (deviceId) => deviceId === 'heater-sub',
    });
    expect(tracker.count({ nowMs: NOW_MS + 30_000 })).toBe(1);
  });
});

describe('decoration controller: isDeviceInSubHome dep threading', () => {
  it('consults the predicate per task during decorate and leaves the task un-admitted', () => {
    const isDeviceInSubHome = vi.fn((deviceId: string) => deviceId === 'heater-sub');
    const controller = new DeferredObjectiveDecorationController({
      getDeferredObjectiveSettings: () => normalizeDeferredObjectiveSettings({
        version: 1,
        objectivesByDeviceId: { 'heater-sub': heaterEntry },
      }),
      getTimeZone: () => 'UTC',
      getPowerTracker: () => ({ lastTimestamp: NOW_MS }),
      getPriceOptimizationEnabled: () => true,
      buildPriceHorizon: () => [],
      getHardCapKw: () => 10,
      isDeviceInSubHome,
    });
    const bundle = controller.decorate({
      devices: [buildHeaterDevice()],
      dailyBudgetSnapshot: null,
      nowTs: NOW_MS,
    });
    expect(isDeviceInSubHome).toHaveBeenCalledWith('heater-sub');
    expect(bundle.admittedDeviceIds.has('heater-sub')).toBe(false);
    expect(bundle.forceShedSet.size).toBe(0);
  });
});
