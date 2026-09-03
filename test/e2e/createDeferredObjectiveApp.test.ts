import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import {
  readAllObjectives,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectiveSettingsV1,
} from '../../lib/objectives/deferredObjectives';
import {
  DEFERRED_OBJECTIVES_SETTINGS,
  DEFERRED_OBJECTIVES_PERKEY_MIGRATED,
} from '../../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

// A managed temperature device in the runtime-planned snapshot, with a 30..75 °C
// settable target so device-specific bounds validation has a real range.
const buildPlannedHeater = (): TargetDeviceSnapshot => {
  const target = { id: 'target_temperature' as const, value: 50, min: 30, max: 75, step: 0.5 };
  return {
    id: 'heater-1',
    name: 'Boiler',
    capabilities: ['target_temperature', 'measure_temperature', 'measure_power'],
    targets: [target],
    temperature: { currentTemperature: 45, target },
  } as unknown as TargetDeviceSnapshot;
};

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
    const candidates = app.getCreateSmartTaskCandidateDevices();
    expect(candidates.state === 'ready'
      && candidates.devices.some((d: { id: string }) => d.id === 'heater-1')).toBe(false);
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

    it('GUARDRAIL: never strips a grant that is ALREADY STANDING, even when the device reads ineligible', async () => {
      // The eligibility test reads `controlModel`, which is re-derived from live
      // device reads and is blank for an auto-native-wired stepper during the
      // post-restart window. On the settings-UI edit lane — which writes with
      // `replace` — stripping there would turn an unrelated goal edit into a
      // PERMANENT revocation of an effective permission. A caller that passes the
      // standing set gets the grant preserved through the degraded read.
      const app = await initApp(); // default heater snapshot reads as non-stepped
      // Seed the grant while the device still reads as a stepper, then let the
      // snapshot go back to non-stepped — the shape of a post-restart window
      // where `controlModel` has not been re-derived yet.
      app.setSnapshotForTests([steppedHeater()]);
      app.createDeferredObjective(
        'heater-1',
        withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
        'settings_ui:smart_task_update',
        'replace',
      );
      app.setSnapshotForTests([buildPlannedHeater() as unknown as TargetDeviceSnapshot]);
      const result = app.createDeferredObjective(
        'heater-1',
        withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
        'settings_ui:smart_task_update',
        'replace',
      );
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue)
        .toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' });
      await app.onUninit?.();
    });

    it('STRIPS an established limit grant once its budget exemption is revoked', async () => {
      // For an established grant, the exemption conjunct is enforced only as a
      // revocation TRANSITION: this request takes the stored 'always' pairing
      // away while keeping the limit toggle, so the pair-gated grant goes with
      // it. A standing grant with no stored pairing is the different case the
      // Flow-granted limit-only test below pins — it survives.
      const app = await initApp();
      app.setSnapshotForTests([steppedHeater()]);
      app.createDeferredObjective(
        'heater-1',
        withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
        'settings_ui:smart_task_update',
        'replace',
      );
      expect(readStored().objectivesByDeviceId['heater-1'].rescue)
        .toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' });

      const result = app.createDeferredObjective(
        'heater-1',
        withRescue({ limitLowerPriorityDevices: 'always' }),
        'settings_ui:smart_task_update',
        'replace',
      );
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toBeUndefined();
      await app.onUninit?.();
    });

    it('KEEPS a standing Flow-granted limit-only grant across a goal-only edit', async () => {
      // The Flow card is the authority on rescue and writes limit-only grants
      // verbatim; the runtime honours them (`limitLowerPriorityApplied` keys on
      // the grant alone). The editor names all three permissions on every save,
      // so the gate must treat this as an established grant with no stored
      // exemption pairing to revoke — not as a new pair-gated request. Pre-fix,
      // any goal-only edit silently erased the working grant.
      const app = await initApp();
      app.setSnapshotForTests([steppedHeater()]);
      app.createDeferredObjective('heater-1', tempCandidate(60));
      const grantViaFlow = mockHomeyInstance.flow._actionCardListeners['allow_smart_task_rescue'];
      await grantViaFlow({
        device: { id: 'heater-1' },
        property: { id: 'limit_lower_priority' },
        when: { id: 'always' },
      });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue)
        .toEqual({ limitLowerPriorityDevices: 'always' });

      const result = app.createDeferredObjective(
        'heater-1',
        { ...tempCandidate(62), rescue: { limitLowerPriorityDevices: 'always' } },
        'settings_ui:smart_task_update',
        'replace',
      );
      expect(result).toEqual({ ok: true });
      const entry = readStored().objectivesByDeviceId['heater-1'];
      expect(entry).toMatchObject({ targetTemperatureC: 62 });
      expect(entry.rescue).toEqual({ limitLowerPriorityDevices: 'always' });
      await app.onUninit?.();
    });

    it('still strips a NEWLY requested limit grant on the same ineligible device', async () => {
      // The counterpart to the guardrail above: with nothing standing, the gate
      // is still the defence-in-depth it always was, so a tampered client cannot
      // persist a permission this device can't honour.
      const app = await initApp();
      const result = app.createDeferredObjective(
        'heater-1',
        withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
        'settings_ui:smart_task_update',
        'replace',
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

    it('KEEPS limit-lower-priority on a stepped device below top priority', async () => {
      // The gate is NOT the planner's `fullyReserved === 1` floor. Limiting
      // lower-priority devices works at any priority — swap selection already
      // refuses any candidate that is not strictly lower priority, so a boosted
      // priority-100 device can only displace something below it. Withholding the
      // grant here silently left every non-top device without the one permission
      // that clears capacity for it.
      const app = await initApp();
      app.setSnapshotForTests([steppedHeater(100)]);
      const result = app.createDeferredObjective(
        'heater-1', withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
      );
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue)
        .toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' });
      await app.onUninit?.();
    });

    it('persists the pause permission ungated, alongside the others', async () => {
      // `pauseLowerPriorityDevices` is priority-relative by construction and is
      // never touched by the gate — the rescue relies on that to reserve startup
      // power for a device the budget exemption alone cannot unblock.
      const app = await initApp();
      app.setSnapshotForTests([steppedHeater(100)]);
      const result = app.createDeferredObjective('heater-1', withRescue({
        exemptFromBudget: 'always',
        limitLowerPriorityDevices: 'always',
        pauseLowerPriorityDevices: 'always',
      }));
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toEqual({
        exemptFromBudget: 'always',
        limitLowerPriorityDevices: 'always',
        pauseLowerPriorityDevices: 'always',
      });
      await app.onUninit?.();
    });

    it('PRESERVES a standing permission when a fresh create opts out (additive-only preserve policy)', async () => {
      // Documented contract: the create screen rebuilds an entry from goal/deadline
      // and never carries a device's existing standing permission, so a create with
      // both toggles off must NOT wipe a permission set elsewhere (e.g. via Flow or
      // the rescue lane).
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

  // Settings-UI clear lane. The ordering contract mirrors the `clear_deadline`
  // Flow card: the status-bus / hours-tracker memory is forgotten only AFTER a
  // confirmed persist, so a refused clear never desyncs lifecycle surfaces
  // from a task that is still stored.
  describe('cancelDeferredObjective', () => {
    it('clears the stored task, then forgets the status-bus and hours-tracker memory', async () => {
      const app = await initApp();
      expect(app.createDeferredObjective('heater-1', tempCandidate(60))).toEqual({ ok: true });
      const forgetStatus = vi.spyOn(app.deferredObjectiveStatusBus, 'forgetDevice');
      const forgetHours = vi.spyOn(app.deferredObjectiveHoursRemainingTracker, 'forgetDevice');

      expect(app.cancelDeferredObjective('heater-1')).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1']).toBeUndefined();
      expect(forgetStatus).toHaveBeenCalledWith('heater-1');
      expect(forgetHours).toHaveBeenCalledWith('heater-1');
      await app.onUninit?.();
    });

    it('answers task_not_found for a device without a task and forgets nothing', async () => {
      const app = await initApp();
      const forgetStatus = vi.spyOn(app.deferredObjectiveStatusBus, 'forgetDevice');
      const forgetHours = vi.spyOn(app.deferredObjectiveHoursRemainingTracker, 'forgetDevice');

      expect(app.cancelDeferredObjective('heater-1')).toEqual({ ok: false, reason: 'task_not_found' });
      expect(forgetStatus).not.toHaveBeenCalled();
      expect(forgetHours).not.toHaveBeenCalled();
      await app.onUninit?.();
    });

    it('GUARDRAIL: a refused clear leaves the task stored and the bus memory intact', async () => {
      const app = await initApp();
      expect(app.createDeferredObjective('heater-1', tempCandidate(60))).toEqual({ ok: true });
      const forgetStatus = vi.spyOn(app.deferredObjectiveStatusBus, 'forgetDevice');
      const forgetHours = vi.spyOn(app.deferredObjectiveHoursRemainingTracker, 'forgetDevice');
      // Simulate the boot-time transient-empty `getKeys()` flake with the
      // migration marker unset: `ensureMigrated` then refuses the write.
      mockHomeyInstance.settings.unset(DEFERRED_OBJECTIVES_PERKEY_MIGRATED);
      const getKeysSpy = vi.spyOn(mockHomeyInstance.settings, 'getKeys').mockReturnValue([]);

      expect(app.cancelDeferredObjective('heater-1')).toEqual({ ok: false, reason: 'write_refused' });
      getKeysSpy.mockRestore();
      expect(readStored().objectivesByDeviceId['heater-1']).toMatchObject({ targetTemperatureC: 60 });
      expect(forgetStatus).not.toHaveBeenCalled();
      expect(forgetHours).not.toHaveBeenCalled();
      await app.onUninit?.();
    });
  });
});
