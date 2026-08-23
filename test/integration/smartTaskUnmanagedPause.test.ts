// Integration coverage for the "device is no longer managed" smart-task pause
// (`unmanaged` exclusion → `objective_device_unmanaged`):
// - un-managing a device does NOT end its task; the diagnostic reports the
//   dedicated paused code instead of the misleading `objective_missing_device`
//   (the device exists — PELS is simply not managing it);
// - the paused task takes no share of the allocation, so a sibling task is not
//   under-booked while it waits;
// - managing the device again resumes planning on the next cycle, with nothing
//   to restore — the objective was never touched;
// - the wiring predicate answers on the OWNER's explicit opt-out only, so a
//   device that left Homey still reports honestly as missing.
import { describe, expect, it, vi } from 'vitest';
import { handleDeferredDeadlineReached } from '../../setup/appInit/deferredObjectiveLifecycle';
import type { AppContext } from '../../lib/app/appContext';
import {
  buildDeferredObjectiveDiagnostics,
  normalizeDeferredObjectiveSettings,
} from '../../lib/objectives/deferredObjectives';
import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import {
  orderDeferredObjectives,
  PriorityAllocationTracker,
} from '../../lib/objectives/deferredObjectives/priorityAllocation';
import { resolvePendingReason } from '../../lib/objectives/deferredObjectives/activePlanRevisionBuild';
import { resolveDiagnosticReasonCode } from '../../lib/objectives/deferredObjectives/activePlanDiagnosticReason';
import {
  hasTrustworthyProgress,
  PROGRESS_UNTRUSTWORTHY_REASON_CODES,
} from '../../lib/objectives/deferredObjectives/planHistoryV4Helpers';
import type { ResolveObjectiveDeviceExclusion } from '../../lib/objectives/deferredObjectives/deviceExclusion';
import { resolveSmartTaskDeviceExclusion } from '../../setup/appInit/smartTaskHomeScope';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { DeferredObjectiveSettingsEntry } from '../../lib/objectives/deferredObjectives/settings';
import { withFixtureResidualKw } from '../utils/planTestUtils';
import {
  withBinaryDiscriminant,
  withTemperatureDiscriminant,
  type PlanInputDevice,
} from '../../lib/plan/planTypes';

const NOW_MS = Date.UTC(2026, 0, 1, 12, 0, 0);
const DEADLINE_MS = NOW_MS + 6 * 60 * 60 * 1000;

const heaterEntry: DeferredObjectiveSettingsEntry = {
  enabled: true,
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC: 60,
  deadlineAtMs: DEADLINE_MS,
};

const buildHeaterDevice = (id: string): PlanInputDevice => withTemperatureDiscriminant(
  withBinaryDiscriminant(withFixtureResidualKw({
    controllable: true,
    available: true,
    currentDrawKw: 0,
    id,
    expectedPowerKw: 1,
    expectedPowerSource: 'default',
    name: 'Bathroom heater',
    commandableNow: true,
    objectiveSessionInactive: false,
    boostSupported: false,
    boostRequested: false,
    hasStandingDemand: true,
    confirmedNotDrawing: false,
    targets: [{ id: 'target_temperature', value: 55, unit: 'C', min: 0, max: 95, step: 0.5 }],
    binaryControl: { on: false },
    deviceType: 'temperature' as const,
    controlCapabilityId: 'onoff' as const,
    currentTemperature: 40,
    lastFreshDataMs: NOW_MS,
  })),
) as PlanInputDevice;

const buildDiagnosticsParams = (overrides: {
  devices: PlanInputDevice[];
  deviceIds?: string[];
  resolveDeviceExclusion?: ResolveObjectiveDeviceExclusion;
}) => ({
  nowMs: NOW_MS,
  timeZone: 'UTC',
  devices: overrides.devices,
  settings: normalizeDeferredObjectiveSettings({
    version: 1,
    objectivesByDeviceId: Object.fromEntries(
      (overrides.deviceIds ?? ['heater-1']).map((id) => [id, heaterEntry]),
    ),
  }),
  powerTracker: { lastTimestamp: NOW_MS },
  dailyBudgetSnapshot: null,
  buildPriceHorizon: () => [],
  priceOptimizationEnabled: true,
  ...(overrides.resolveDeviceExclusion
    ? { resolveDeviceExclusion: overrides.resolveDeviceExclusion }
    : {}),
});

describe('smart task on an un-managed device', () => {
  it('pauses with the dedicated code instead of claiming the device is missing', () => {
    // The managed filter drops the device from the plan input, exactly as a
    // vanished device would — the exclusion resolver is what tells them apart.
    const diagnostics = buildDeferredObjectiveDiagnostics(buildDiagnosticsParams({
      devices: [],
      resolveDeviceExclusion: () => 'unmanaged',
    }));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].trajectory).toEqual({
      kind: 'unavailable',
      reasonCode: 'objective_device_unmanaged',
    });
    expect(diagnostics[0].reasonCode).toBe('objective_device_unmanaged');
  });

  it('keeps the task itself intact — the objective is still enabled and enumerated', () => {
    const params = buildDiagnosticsParams({
      devices: [],
      resolveDeviceExclusion: () => 'unmanaged',
    });
    buildDeferredObjectiveDiagnostics(params);
    expect(params.settings.objectivesByDeviceId['heater-1']?.enabled).toBe(true);
    expect(params.settings.objectivesByDeviceId['heater-1']?.deadlineAtMs).toBe(DEADLINE_MS);
  });

  it('never governs the device while paused', () => {
    const devices = [buildHeaterDevice('heater-1')];
    const diagnostics = buildDeferredObjectiveDiagnostics(buildDiagnosticsParams({
      devices,
      resolveDeviceExclusion: () => 'unmanaged',
    }));
    expect(applyDeferredObjectiveAdmission(diagnostics, devices).get('heater-1')?.kind)
      .toBe('inactive');
  });

  it('resumes on the next cycle once the device is managed again', () => {
    const diagnostics = buildDeferredObjectiveDiagnostics(buildDiagnosticsParams({
      devices: [buildHeaterDevice('heater-1')],
      resolveDeviceExclusion: () => null,
    }));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].reasonCode).not.toBe('objective_device_unmanaged');
    expect(diagnostics[0].reasonCode).not.toBe('objective_missing_device');
  });

  it('takes no allocation share while paused, so a sibling task is not under-booked', () => {
    const tracker = new PriorityAllocationTracker();
    const running = buildHeaterDevice('heater-running');
    // Both devices are managed and seen once...
    tracker.observe({ devices: [running, buildHeaterDevice('heater-1')], nowMs: NOW_MS });
    // ...then one is un-managed and leaves the plan input. Unlike an SDK miss,
    // it is purged from the roster outright instead of holding its share
    // through the missing-device grace window.
    const ordered = orderDeferredObjectives({
      settings: normalizeDeferredObjectiveSettings({
        version: 1,
        objectivesByDeviceId: { 'heater-1': heaterEntry, 'heater-running': heaterEntry },
      }),
      deviceById: new Map([[running.id, running]]),
      isDeviceExcluded: (deviceId) => deviceId === 'heater-1',
      tracker,
      nowMs: NOW_MS + 30_000,
    });
    expect(ordered.map((entry) => entry.deviceId)).toEqual(['heater-running']);
  });

  it('carries the pause onto the persisted plan record, not a stale on-track chip', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics(buildDiagnosticsParams({
      devices: [],
      resolveDeviceExclusion: () => 'unmanaged',
    }));
    expect(resolvePendingReason(diagnostic)).toBe('device_unmanaged');
    expect(resolveDiagnosticReasonCode(diagnostic)).toBe('objective_device_unmanaged');
  });

  it('writes no progress samples from a diagnostic built without reading the device', () => {
    const [diagnostic] = buildDeferredObjectiveDiagnostics(buildDiagnosticsParams({
      devices: [],
      resolveDeviceExclusion: () => 'unmanaged',
    }));
    // `hasTrustworthyProgress` is the gate the recorder actually applies before
    // writing `progressSamples` / `finalProgress*`; the set below is what backs
    // it, asserted too so the code cannot quietly leave the set.
    expect(hasTrustworthyProgress(diagnostic)).toBe(false);
    expect(PROGRESS_UNTRUSTWORTHY_REASON_CODES.has('objective_device_unmanaged')).toBe(true);
  });
});

describe('resolveSmartTaskDeviceExclusion', () => {
  // Mirrors `AppHostApi.resolveManagedState` (`managedDevices[id] === true`).
  // Its observe-only-role arm is irrelevant here: a battery or PV device cannot
  // carry a smart task.
  const buildCtx = (managedDevices: Record<string, boolean>) => createAppContextMock({
    managedDevices,
    resolveManagedState: (deviceId: string) => managedDevices[deviceId] === true,
  });

  it('answers `unmanaged` on the owner’s explicit opt-out', () => {
    expect(resolveSmartTaskDeviceExclusion(buildCtx({ 'heater-1': false, other: true }), 'heater-1'))
      .toBe('unmanaged');
  });

  it('answers `unmanaged` when the owner un-manages their ONLY managed device', () => {
    // The commonest shape there is, and the one a "some device is opted in"
    // fence would silence: the map is now all-`false`, which is an owner's
    // answer, not an unread setting.
    expect(resolveSmartTaskDeviceExclusion(buildCtx({ 'heater-1': false }), 'heater-1'))
      .toBe('unmanaged');
  });

  it('answers `unmanaged` for a never-toggled device too — the planner drops it either way', () => {
    expect(resolveSmartTaskDeviceExclusion(buildCtx({ other: true }), 'heater-1')).toBe('unmanaged');
  });

  it('answers null for a managed device', () => {
    expect(resolveSmartTaskDeviceExclusion(buildCtx({ 'heater-1': true }), 'heater-1'))
      .toBeNull();
  });

  it('stays silent on an EMPTY map, the one state that carries no owner answer', () => {
    // `ctx.managedDevices` is `{}` until `loadCapacitySettings` runs. Startup
    // ordering already puts that before any diagnostic; the guard is here so a
    // future reordering cannot turn the boot window into a flash of "paused".
    expect(resolveSmartTaskDeviceExclusion(buildCtx({}), 'heater-1')).toBeNull();
  });

  it('reports the sub-home scope first when both apply', () => {
    const ctx = createAppContextMock({
      managedDevices: { 'heater-1': false, other: true },
      resolveManagedState: () => false,
      homeMembership: {
        isOwnershipReady: () => true,
        hasPendingOwnershipGeneration: () => false,
        getHomeIdForDevice: () => 'home-2',
      } as never,
    });
    expect(resolveSmartTaskDeviceExclusion(ctx, 'heater-1')).toBe('sub_home');
  });
});

// ─── Deadline terminal fallback ─────────────────────────────────────────────
//
// The pause promise is "PELS plans nothing for this device". The deadline
// fallback is the one lane that can still write to a device the planner has
// dropped, so it needs its own gate — `isCapacityControlEnabled` is false for an
// un-managed device, which is exactly the condition that USED to fall through to
// actuation. The fixture below is deliberately actuation-capable (present,
// available, ON, writable binary axis), so a missing gate shows up as a command,
// not as a crash.

const DEADLINE_MS_LIFECYCLE = NOW_MS + 60_000;

const buildTerminalFallbackCtx = (managedDevices: Record<string, boolean>) => {
  const settingsStore = new Map<string, unknown>([
    ['deferred_objective.d1', {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: 21,
      deadlineAtMs: DEADLINE_MS_LIFECYCLE,
    }],
  ]);
  const setCapability = vi.fn().mockResolvedValue(undefined);
  const applyDeviceTargets = vi.fn().mockResolvedValue(undefined);
  const converge = vi.fn(() => ({ settled: true }));
  const abandon = vi.fn();
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
    managedDevices,
    resolveManagedState: (deviceId: string) => managedDevices[deviceId] === true,
    // False for an un-managed device AND for a managed-but-not-capacity-
    // controlled one; only the exclusion tells the two apart.
    isCapacityControlEnabled: () => false,
    homeMembership: {
      getHomeIdForDevice: () => 'main',
      isOwnershipReady: () => true,
      hasPendingOwnershipGeneration: () => false,
      isMainHomeActuationFenced: () => false,
      getConfiguredMeterSources: () => ({ state: 'resolved', deviceIds: new Set<string>() }),
    } as unknown as AppContext['homeMembership'],
    deviceManager: { setCapability, applyDeviceTargets } as unknown as AppContext['deviceManager'],
    lifecycleFallback: { converge, abandon },
    deviceControlHelpers: {
      getLifecycleFallbackDevice: () => ({
        id: 'd1',
        name: 'Bathroom heater',
        binaryAxis: { state: 'writable', descriptor: { controlCapabilityId: 'onoff' } },
        targetAxis: { state: 'unavailable' },
        stepAxis: { state: 'unavailable' },
      }),
    } as unknown as AppContext['deviceControlHelpers'],
    getObservedState: () => ({
      id: 'd1',
      name: 'Bathroom heater',
      available: true,
      binaryControl: { on: true },
      targets: [],
    }),
    deferredObjectiveStatusBus: { forgetDevice: vi.fn() } as unknown as AppContext['deferredObjectiveStatusBus'],
    deferredObjectiveActivePlanRecorder: {
      clearForDevice: vi.fn(),
      getActivePlansSnapshot: () => ({ version: 1, plansByDeviceId: {} }),
    } as unknown as AppContext['deferredObjectiveActivePlanRecorder'],
  });
  return { ctx, settingsStore, converge, abandon, setCapability, applyDeviceTargets };
};

describe('handleDeferredDeadlineReached: an un-managed device gets no terminal actuation', () => {
  it('disarms the task without writing anything to the device', () => {
    const h = buildTerminalFallbackCtx({ 'd1': false });

    handleDeferredDeadlineReached(h.ctx, 'd1', DEADLINE_MS_LIFECYCLE, DEADLINE_MS_LIFECYCLE + 1_000);

    expect(h.converge).not.toHaveBeenCalled();
    expect(h.setCapability).not.toHaveBeenCalled();
    expect(h.applyDeviceTargets).not.toHaveBeenCalled();
    expect(h.abandon).toHaveBeenCalledWith('d1');
    expect((h.settingsStore.get('deferred_objective.d1') as { enabled: boolean }).enabled).toBe(false);
  });

  it('control: the same fixture DOES converge once the device is managed again', () => {
    const h = buildTerminalFallbackCtx({ 'd1': true });

    handleDeferredDeadlineReached(h.ctx, 'd1', DEADLINE_MS_LIFECYCLE, DEADLINE_MS_LIFECYCLE + 1_000);

    expect(h.converge).toHaveBeenCalled();
  });
});
