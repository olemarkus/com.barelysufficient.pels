import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { cleanupApps, createApp } from './utils/appTestUtils';
import {
  readAllObjectives,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectiveSettingsV1,
} from '../lib/objectives/deferredObjectives';
import {
  DEFERRED_OBJECTIVES_SETTINGS,
  DEFERRED_OBJECTIVES_PERKEY_MIGRATED,
} from '../lib/utils/settingsKeys';
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

// The rescue candidate the widget API builds: the device's intended normal
// target, a near-term deadline, and the budget exemption.
const rescueCandidate = (targetTemperatureC: number): DeferredObjectivePlanPreviewCandidate => ({
  ...tempCandidate(targetTemperatureC),
  deadlineAtMs: Date.now() + 3 * 60 * 60 * 1000,
  rescue: { exemptFromBudget: 'always' },
});

const readStored = (): DeferredObjectiveSettingsV1 => (
  readAllObjectives(mockHomeyInstance.settings)
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

  // The create-smart-task widget's opt-in "Extra permissions" ride the candidate;
  // the app re-gates them against the device (defence-in-depth) so a tampered or
  // stale client can never persist a permission the device can't honour.
  describe('extra-permissions gate (create)', () => {
    const steppedHeater = (priority = 1): TargetDeviceSnapshot => ({
      ...buildPlannedHeater(),
      priority,
      controlModel: 'stepped_load',
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [{ id: 'off', planningPowerW: 0 }, { id: 'on', planningPowerW: 2000 }],
      },
    } as unknown as TargetDeviceSnapshot);
    const withRescue = (
      rescue: DeferredObjectivePlanPreviewCandidate['rescue'],
    ): DeferredObjectivePlanPreviewCandidate => ({ ...tempCandidate(60), rescue });

    it('persists both permissions for a stepped device with budget exemption', async () => {
      const app = await initApp();
      app.setSnapshotForTests([steppedHeater()]);
      const result = app.createDeferredObjective(
        'heater-1', withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
      );
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue)
        .toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' });
      await app.onUninit?.();
    });

    it('STRIPS limit-lower-priority on a non-stepped device (binary has no step to promote)', async () => {
      const app = await initApp(); // default heater is non-stepped
      const result = app.createDeferredObjective(
        'heater-1', withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
      );
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toEqual({ exemptFromBudget: 'always' });
      await app.onUninit?.();
    });

    it('STRIPS limit-lower-priority when budget exemption is not also granted (inert alone)', async () => {
      const app = await initApp();
      app.setSnapshotForTests([steppedHeater()]);
      const result = app.createDeferredObjective('heater-1', withRescue({ limitLowerPriorityDevices: 'always' }));
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toBeUndefined();
      await app.onUninit?.();
    });

    it('STRIPS limit-lower-priority on a stepped device below top priority (inert at the planner)', async () => {
      // Matches the planner's fullyReserved === 1 floor: a stepped device that is
      // not priority 1 can never honour the grant, so a tampered/stale client that
      // sends it must not get it persisted (gate ≡ widget gate-on-effect).
      const app = await initApp();
      app.setSnapshotForTests([steppedHeater(100)]);
      const result = app.createDeferredObjective(
        'heater-1', withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
      );
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toEqual({ exemptFromBudget: 'always' });
      await app.onUninit?.();
    });

    it('PRESERVES a standing permission when a fresh create opts out (additive-only preserve policy)', async () => {
      // Documented contract: the create screen rebuilds an entry from goal/deadline
      // and never carries a device's existing standing permission, so a create with
      // both toggles off must NOT wipe a permission set elsewhere (e.g. via Flow or
      // the rescue lane). See the create-screen opt-out follow-up in TODO.md.
      const app = await initApp(); // non-stepped heater → standing exemption is budget-only
      app.rescueDeviceWithBudgetExemption('heater-1', rescueCandidate(60));
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toEqual({ exemptFromBudget: 'always' });
      const result = app.createDeferredObjective('heater-1', tempCandidate(62));
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toEqual({ exemptFromBudget: 'always' });
      await app.onUninit?.();
    });
  });

  describe('rescueDeviceWithBudgetExemption (fresh create — reuses the create engine)', () => {
    it('creates the rescue objective when the device has none', async () => {
      const app = await initApp();
      const result = app.rescueDeviceWithBudgetExemption('heater-1', rescueCandidate(65));
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1']).toMatchObject({
        enabled: true,
        kind: 'temperature',
        targetTemperatureC: 65,
        rescue: { exemptFromBudget: 'always' },
      });
      await app.onUninit?.();
    });

    it('REJECTS a device that already has a smart task (device_not_eligible — never clobbers it)', async () => {
      const app = await initApp();
      // The user already has their own task: target 70 °C, a later deadline.
      const ownDeadline = Date.now() + 6 * 60 * 60 * 1000;
      const created = app.createDeferredObjective('heater-1', {
        kind: 'temperature', enforcement: 'soft', targetTemperatureC: 70, deadlineAtMs: ownDeadline,
      });
      expect(created).toEqual({ ok: true });

      // A task-having device is excluded from the rescue (no merge); the lane
      // re-asserts it so a stale/tampered request can never replace the user's task.
      const result = app.rescueDeviceWithBudgetExemption('heater-1', rescueCandidate(65));
      expect(result).toEqual({ ok: false, reason: 'device_not_eligible' });
      // The user's task is untouched — target, deadline, and no rescue grant added.
      expect(readStored().objectivesByDeviceId['heater-1']).toMatchObject({
        targetTemperatureC: 70,
        deadlineAtMs: ownDeadline,
      });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toBeUndefined();
      await app.onUninit?.();
    });

    it('REJECTS (no clobber) a device whose task is still only in the unmigrated legacy blob', async () => {
      const app = await initApp();
      // Simulate the un-migrated state Codex flagged: the user's task lives ONLY in
      // the legacy blob, the per-key migration marker is unset, and no per-key
      // exists. The per-key `hasDeferredObjectiveForDevice` would miss it — so the
      // rescue must migrate FIRST, then see the task and refuse, never clobber it.
      const ownDeadline = Date.now() + 6 * 60 * 60 * 1000;
      const existing = {
        enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 70, deadlineAtMs: ownDeadline,
      };
      mockHomeyInstance.settings.set(DEFERRED_OBJECTIVES_SETTINGS, {
        version: 1, objectivesByDeviceId: { 'heater-1': existing },
      });
      mockHomeyInstance.settings.unset(DEFERRED_OBJECTIVES_PERKEY_MIGRATED);

      const result = app.rescueDeviceWithBudgetExemption('heater-1', rescueCandidate(65));
      expect(result).toEqual({ ok: false, reason: 'device_not_eligible' });
      // The user's task survived (migrated to per-key, target/deadline intact, no
      // rescue grant written over it).
      expect(readStored().objectivesByDeviceId['heater-1']).toMatchObject({
        targetTemperatureC: 70,
        deadlineAtMs: ownDeadline,
      });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toBeUndefined();
      await app.onUninit?.();
    });

    it('DEFENCE-IN-DEPTH: rejects a candidate that does not carry the budget exemption', async () => {
      const app = await initApp();
      // A plain create candidate (no rescue) must never reach this lane.
      const result = app.rescueDeviceWithBudgetExemption('heater-1', tempCandidate(65));
      expect(result).toEqual({ ok: false, reason: 'invalid_candidate' });
      expect(readStored().objectivesByDeviceId['heater-1']).toBeUndefined();
      await app.onUninit?.();
    });

    it('rejects a picker-only device that is not in the runtime-planned snapshot', async () => {
      const app = await initApp();
      app.getUiPickerDevices = () => [
        { ...buildPlannedHeater(), id: 'picker-only', name: 'Spare heater' },
      ];
      const result = app.rescueDeviceWithBudgetExemption('picker-only', rescueCandidate(65));
      expect(result).toEqual({ ok: false, reason: 'device_not_planned' });
      await app.onUninit?.();
    });
  });

  // A rescue is always a FRESH task (task-having devices are excluded), so the
  // preview simply reuses the create engine's preview of the fresh candidate —
  // the same projection the create persists (preview ≡ persist via the shared
  // `gateCandidateExtraPermissions`). There is no merge case.
  describe('previewStarvationRescuePlan (preview ≡ persist)', () => {
    it('previews the FRESH rescue candidate (target + now+3h), never merging an existing objective', async () => {
      const app = await initApp();
      const candidate = rescueCandidate(65);
      const preview = app.previewStarvationRescuePlan('heater-1', candidate);
      expect(preview.hasExistingObjective).toBe(false);
      // The resolved deadline is the candidate's own (now+3h).
      expect(preview.deadlineAtMs).toBe(candidate.deadlineAtMs);
      await app.onUninit?.();
    });

    it('hasDeferredObjectiveForDevice reflects whether the device has a persisted objective', async () => {
      const app = await initApp();
      expect(app.hasDeferredObjectiveForDevice('heater-1')).toBe(false);
      app.createDeferredObjective('heater-1', tempCandidate(60));
      expect(app.hasDeferredObjectiveForDevice('heater-1')).toBe(true);
      await app.onUninit?.();
    });

    it('does not treat a disabled past objective as an open task for rescue', async () => {
      const app = await initApp();
      const pastEntry = {
        enabled: false,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 60,
        deadlineAtMs: Date.now() - 60 * 1000,
      };
      mockHomeyInstance.settings.set('deferred_objective.heater-1', pastEntry);

      expect(app.hasDeferredObjectiveForDevice('heater-1')).toBe(false);
      const result = app.rescueDeviceWithBudgetExemption('heater-1', rescueCandidate(65));
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1']).toMatchObject({
        enabled: true,
        targetTemperatureC: 65,
      });
      await app.onUninit?.();
    });

    it('still treats a disabled future objective as an open paused task', async () => {
      const app = await initApp();
      const futureEntry = {
        enabled: false,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 60,
        deadlineAtMs: Date.now() + 60 * 60 * 1000,
      };
      mockHomeyInstance.settings.set('deferred_objective.heater-1', futureEntry);

      expect(app.hasDeferredObjectiveForDevice('heater-1')).toBe(true);
      expect(app.rescueDeviceWithBudgetExemption('heater-1', rescueCandidate(65)))
        .toEqual({ ok: false, reason: 'device_not_eligible' });
      expect(readStored().objectivesByDeviceId['heater-1']).toMatchObject(futureEntry);
      await app.onUninit?.();
    });
  });
});
