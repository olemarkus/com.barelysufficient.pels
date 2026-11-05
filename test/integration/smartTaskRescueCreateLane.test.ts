import { describe, expect, it, vi } from 'vitest';
import type { DeferredObjectivePlanPreviewCandidate } from '../../packages/contracts/src/deferredObjectivePlanPreview';
import type { ObjectiveSettingsStore } from '../../lib/objectives/deferredObjectives/objectiveStore';
import type { SmartTaskWriteDevice } from '../../lib/objectives/deferredObjectives/smartTaskWriteValidation';
import {
  createFreshSmartTask,
  upsertSmartTask,
  type SmartTaskWritePorts,
} from '../../lib/objectives/deferredObjectives/smartTaskWrite';
import { createRescueSmartTask } from '../../lib/objectives/deferredObjectives/smartTaskRescueCreateLane';
import { PER_DEVICE_OBJECTIVE_KEY_PREFIX } from '../../lib/utils/settingsKeys';
import { mapSmartTaskAppReason } from '../../lib/objectives/deferredObjectives/smartTaskCandidateRequest';
import { mapAppRescueReason } from '../../packages/shared-domain/src/starvationRescueShared';

// The app side of a smart-task write, with its owner reads stubbed: the
// rescue lane's gates, and the answer before startup has wired the plan
// recorders.

const NOW_MS = Date.UTC(2026, 10, 1, 12);

const memoryStore = (initial: Record<string, unknown> = {}): ObjectiveSettingsStore => {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => { values.set(key, value); },
    unset: (key) => { values.delete(key); },
    getKeys: () => [...values.keys()],
  };
};

const heater: SmartTaskWriteDevice = {
  id: 'heater-1',
  name: 'Boiler',
  isEvCharger: false,
  binaryControllable: true,
  targets: [{ id: 'target_temperature', value: 50, unit: '°C', min: 30, max: 75 }],
  temperature: { currentTemperature: 45, target: { value: 50, min: 30, max: 75 } },
  measuredPowerKw: 2,
};

const tempCandidate = (targetTemperatureC: number): DeferredObjectivePlanPreviewCandidate => ({
  kind: 'temperature',
  enforcement: 'soft',
  targetTemperatureC,
  deadlineAtMs: NOW_MS + 3 * 60 * 60 * 1000,
});

const rescueCandidate = (targetTemperatureC: number): DeferredObjectivePlanPreviewCandidate => ({
  ...tempCandidate(targetTemperatureC),
  rescue: { exemptFromBudget: 'always' },
});

const buildPorts = (
  store: ObjectiveSettingsStore,
  resolveWriteDeps: SmartTaskWritePorts<SmartTaskWriteDevice>['resolveWriteDeps'],
): SmartTaskWritePorts<SmartTaskWriteDevice> => ({
  reads: {
    findPlanInputDevice: (deviceId) => (deviceId === heater.id ? heater : undefined),
    isRuntimePlanned: () => true,
    isPickerDevice: () => true,
    resolveHomeScope: () => 'main',
    store,
  },
  resolveWriteDeps,
  nowMs: NOW_MS,
});

describe('smart-task write before startup wires the plan recorders', () => {
  it('answers the retryable unavailable for every write, never invalid_candidate', () => {
    const resolveWriteDeps = vi.fn(() => null);
    const ports = buildPorts(memoryStore(), resolveWriteDeps);
    expect(upsertSmartTask(ports, 'heater-1', tempCandidate(60), 'preserve'))
      .toEqual({ ok: false, reason: 'unavailable' });
    expect(createFreshSmartTask(ports, 'heater-1', tempCandidate(60)))
      .toEqual({ ok: false, reason: 'unavailable' });
    expect(createRescueSmartTask(ports, 'heater-1', rescueCandidate(60)))
      .toEqual({ ok: false, reason: 'unavailable' });
    expect(resolveWriteDeps).toHaveBeenCalledTimes(3);
  });

  it('reaches the surfaces as unavailable', () => {
    expect(mapSmartTaskAppReason('unavailable')).toBe('unavailable');
    expect(mapAppRescueReason('unavailable')).toBe('unavailable');
  });
});

describe('createRescueSmartTask', () => {
  it('refuses a candidate without the budget exemption before any write', () => {
    const resolveWriteDeps = vi.fn(() => null);
    const result = createRescueSmartTask(buildPorts(memoryStore(), resolveWriteDeps), 'heater-1', tempCandidate(60));
    expect(result).toEqual({ ok: false, reason: 'invalid_candidate' });
    expect(resolveWriteDeps).not.toHaveBeenCalled();
  });

  it('refuses a device with an open task', () => {
    const store = memoryStore({
      [`${PER_DEVICE_OBJECTIVE_KEY_PREFIX}heater-1`]: { ...tempCandidate(70), enabled: true },
    });
    const resolveWriteDeps = vi.fn(() => null);
    const result = createRescueSmartTask(buildPorts(store, resolveWriteDeps), 'heater-1', rescueCandidate(60));
    expect(result).toEqual({ ok: false, reason: 'device_not_eligible' });
    expect(resolveWriteDeps).not.toHaveBeenCalled();
  });
});
