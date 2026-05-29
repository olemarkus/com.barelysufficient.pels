import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { cleanupApps, createApp } from './utils/appTestUtils';
import { DEFERRED_OBJECTIVES_SETTINGS } from '../lib/utils/settingsKeys';
import {
  normalizeDeferredObjectiveSettings,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectiveSettingsV1,
} from '../lib/plan/deferredObjectives';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

// A managed temperature device in the runtime-planned snapshot, with a 30..75 °C
// settable target so device-specific bounds validation has a real range.
const buildPlannedHeater = (): TargetDeviceSnapshot => ({
  id: 'heater-1',
  name: 'Boiler',
  capabilities: ['target_temperature', 'measure_power'],
  targets: [{ id: 'target_temperature', value: 50, min: 30, max: 75, step: 0.5 }],
} as unknown as TargetDeviceSnapshot);

const tempCandidate = (targetTemperatureC: number): DeferredObjectivePlanPreviewCandidate => ({
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC,
  deadlineAtMs: Date.now() + 6 * 60 * 60 * 1000,
});

const readStored = (): DeferredObjectiveSettingsV1 => (
  normalizeDeferredObjectiveSettings(mockHomeyInstance.settings.get(DEFERRED_OBJECTIVES_SETTINGS))
);

describe('createDeferredObjective (app)', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    mockHomeyInstance.api.clearRealtimeEvents();
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  const initApp = async () => {
    const device = new MockDevice('heater-1', 'Boiler', ['measure_power', 'target_temperature']);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    const app = createApp();
    await app.onInit();
    // Pin the runtime-planned snapshot to a known heater with explicit bounds.
    app.setSnapshotForTests([buildPlannedHeater()]);
    return app;
  };

  it('persists a valid create through the device-scoped write op', async () => {
    const app = await initApp();
    const result = app.createDeferredObjective('heater-1', tempCandidate(60));
    expect(result).toEqual({ ok: true });
    expect(readStored().objectivesByDeviceId['heater-1']).toMatchObject({
      enabled: true,
      kind: 'temperature',
      targetTemperatureC: 60,
    });
    await app.onUninit?.();
  });

  it('rejects a target above the device setpoint max (device-specific bounds)', async () => {
    const app = await initApp();
    // 90 °C is inside the generic -50..100 normalizer envelope but ABOVE the
    // device's 75 °C max — must be rejected so an unreachable task never persists.
    const result = app.createDeferredObjective('heater-1', tempCandidate(90));
    expect(result).toEqual({ ok: false, reason: 'invalid_candidate' });
    expect(readStored().objectivesByDeviceId['heater-1']).toBeUndefined();
    await app.onUninit?.();
  });

  it('rejects a target below the device setpoint min (device-specific bounds)', async () => {
    const app = await initApp();
    const result = app.createDeferredObjective('heater-1', tempCandidate(10));
    expect(result).toEqual({ ok: false, reason: 'invalid_candidate' });
    await app.onUninit?.();
  });

  it('rejects a picker-only device that is not in the runtime-planned snapshot', async () => {
    const app = await initApp();
    // The device exists in the picker set but NOT in the runtime snapshot
    // (unmanaged while the managed filter is active) — creating a task on it
    // would never plan. Honest rejection rather than a silent dead task.
    app.getUiPickerDevices = () => [
      { ...buildPlannedHeater(), id: 'picker-only', name: 'Spare heater' },
    ];
    const result = app.createDeferredObjective('picker-only', tempCandidate(60));
    expect(result).toEqual({ ok: false, reason: 'device_not_planned' });
    expect(readStored().objectivesByDeviceId['picker-only']).toBeUndefined();
    await app.onUninit?.();
  });

  it('rejects a managed:false device that IS in the runtime snapshot but the planner drops', async () => {
    // When the managed filter is inactive, the runtime snapshot can carry a
    // `managed: false` device that the plan service's `isRuntimePlannedDevice`
    // (`managed !== false`) filter drops. Offering/persisting it would create a
    // task that never plans or controls anything — reject `device_not_planned`,
    // sharing the exact predicate the candidate listing and planner use.
    const app = await initApp();
    app.setSnapshotForTests([{ ...buildPlannedHeater(), managed: false } as TargetDeviceSnapshot]);
    const result = app.createDeferredObjective('heater-1', tempCandidate(60));
    expect(result).toEqual({ ok: false, reason: 'device_not_planned' });
    expect(readStored().objectivesByDeviceId['heater-1']).toBeUndefined();
    // The same device must not be OFFERED by the candidate list either.
    expect(app.getCreateSmartTaskCandidateDevices().some((d) => d.id === 'heater-1')).toBe(false);
    await app.onUninit?.();
  });

  it('reports device_not_found when the device is in neither set', async () => {
    const app = await initApp();
    app.getUiPickerDevices = () => [];
    const result = app.createDeferredObjective('ghost', tempCandidate(60));
    expect(result).toEqual({ ok: false, reason: 'device_not_found' });
    await app.onUninit?.();
  });

  it('rejects an EV-SoC candidate on a temperature device (kind mismatch)', async () => {
    const app = await initApp();
    const evCandidate: DeferredObjectivePlanPreviewCandidate = {
      kind: 'ev_soc',
      enforcement: 'soft',
      targetPercent: 80,
      deadlineAtMs: Date.now() + 6 * 60 * 60 * 1000,
    };
    const result = app.createDeferredObjective('heater-1', evCandidate);
    expect(result).toEqual({ ok: false, reason: 'device_not_eligible' });
    await app.onUninit?.();
  });
});
