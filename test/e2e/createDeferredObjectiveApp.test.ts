import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import {
  readAllObjectives,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectiveSettingsV1,
} from '../../lib/objectives/deferredObjectives';
import {
  CAPACITY_PRIORITIES,
  DEFERRED_OBJECTIVES_SETTINGS,
  DEFERRED_OBJECTIVES_PERKEY_MIGRATED,
  DEVICE_CONTROL_PROFILES,
  MANAGED_DEVICES,
} from '../../lib/utils/settingsKeys';
import { buildCreateSmartTaskDevicesPayload } from '../../widgets/create_smart_task/src/createSmartTaskWidgetPayload';

// A heater as Homey reports it: a 30..75 °C settable target, so device-specific
// bounds validation has a real range, and a real power reading.
const buildHomeyHeater = async (id = 'heater-1', name = 'Boiler'): Promise<MockDevice> => {
  const heater = new MockDevice(id, name, ['measure_power', 'target_temperature']);
  heater.setCapabilityMetadata('target_temperature', { min: 30, max: 75, step: 0.5 });
  await heater.setCapabilityValue('target_temperature', 50);
  await heater.setCapabilityValue('measure_temperature', 45);
  await heater.setCapabilityValue('measure_power', 2000);
  return heater;
};

// The ladder an owner saves to run the heater as a stepped load.
const STEPPED_HEATER_PROFILE = {
  steps: [{ id: 'off', planningPowerW: 0 }, { id: 'on', planningPowerW: 2000 }],
};

// A metered EV charger as Homey reports it. Its class is the only thing that
// makes it an EV charger: nothing here says so, and the app must resolve it
// when it parses the device. Every capability PELS reads is reported with a
// dated value, or the device-read contract ignores the read.
const buildHomeyCharger = async (): Promise<MockDevice> => {
  const charger = new MockDevice(
    'ev-1',
    'Driveway charger',
    ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
    'evcharger',
  );
  await charger.setCapabilityValue('evcharger_charging', false);
  await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_paused');
  await charger.setCapabilityValue('measure_power', 0);
  return charger;
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

  type InitAppOptions = {
    heater?: MockDevice;
    /** `false` leaves the managed filter inactive, with the heater opted out. */
    managed?: boolean;
    /** The owner saved a stepped-load ladder for the heater. */
    stepped?: boolean;
    /** Another managed device outranks the heater. */
    belowTopPriority?: boolean;
  };

  // Boot the app on a heater the owner manages, as the refresh parses it.
  const initApp = async (options: InitAppOptions = {}) => {
    const heater = options.heater ?? await buildHomeyHeater();
    const devices = [heater];
    const managed: Record<string, boolean> = { 'heater-1': options.managed ?? true };
    if (options.belowTopPriority) {
      const socket = new MockDevice('socket-1', 'Socket', ['onoff'], 'socket');
      await socket.setCapabilityValue('onoff', true);
      await socket.setCapabilityValue('measure_power', 500);
      devices.push(socket);
      managed['socket-1'] = true;
      mockHomeyInstance.settings.set(CAPACITY_PRIORITIES, { Home: { 'socket-1': 1, 'heater-1': 2 } });
    }
    setMockDrivers({ driverA: new MockDriver('driverA', devices) });
    mockHomeyInstance.settings.set(MANAGED_DEVICES, managed);
    if (options.stepped) {
      mockHomeyInstance.settings.set(DEVICE_CONTROL_PROFILES, { 'heater-1': STEPPED_HEATER_PROFILE });
    }
    const app = createApp();
    await app.onInit();
    return app;
  };

  // A heater the owner has not opted in while the managed filter is active:
  // the settings picker lists it, the runtime snapshot does not.
  const initAppWithPickerOnlyHeater = async () => {
    const pickerOnly = await buildHomeyHeater('picker-only', 'Spare heater');
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildHomeyHeater(), pickerOnly]) });
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { 'heater-1': true });
    const app = createApp();
    await app.onInit();
    expect(app.getUiPickerDevices().map((device: { id: string }) => device.id)).toContain('picker-only');
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
    // The device exists in the picker set but NOT in the runtime snapshot
    // (unmanaged while the managed filter is active) — creating a task on it
    // would never plan. Honest rejection rather than a silent dead task.
    const app = await initAppWithPickerOnlyHeater();
    const result = app.createDeferredObjective('picker-only', tempCandidate(60));
    expect(result).toEqual({ ok: false, reason: 'device_not_planned' });
    expect(readStored().objectivesByDeviceId['picker-only']).toBeUndefined();
    await app.onUninit?.();
  });

  it('rejects a device with no per-device power reading', async () => {
    // A heater with no power meter: planned for its mode target, never metered.
    // (A meter that is declared but has not reported cannot reach the plan: the
    // read contract ignores a device read that declares a capability with no
    // value.)
    const unmetered = await buildHomeyHeater();
    unmetered.removeCapability('measure_power');
    const app = await initApp({ heater: unmetered });

    const result = app.createDeferredObjective('heater-1', tempCandidate(60));

    expect(result).toEqual({ ok: false, reason: 'device_not_planned' });
    await app.onUninit?.();
  });

  it('rejects a managed:false device that IS in the runtime snapshot but the planner drops', async () => {
    // When the managed filter is inactive, the runtime snapshot can carry a
    // `managed: false` device that the plan service's `isRuntimePlannedDevice`
    // (`managed !== false`) filter drops. Offering/persisting it would create a
    // task that never plans or controls anything — reject `device_not_planned`,
    // sharing the exact predicate the candidate listing and planner use.
    const app = await initApp({ managed: false });
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

  it('offers a managed EV charger in the widget and persists an EV-SoC task on it', async () => {
    // The charger class is inventory metadata, which planner input omits. Read
    // from planner input, every EV charger resolved to no smart-task kind: the
    // widget never offered one and a create was refused as not eligible. The
    // charger is registered with Homey and parsed by the app, so the identity the
    // widget and the create lane read is the one the app resolved from the class.
    setMockDrivers({ ev: new MockDriver('ev', [await buildHomeyCharger()]) });
    mockHomeyInstance.settings.set(MANAGED_DEVICES, { 'ev-1': true });
    const app = createApp();
    await app.onInit();

    const read = app.getCreateSmartTaskCandidateDevices();
    expect(read.state).toBe('ready');
    const payload = buildCreateSmartTaskDevicesPayload({ devices: read.state === 'ready' ? read.devices : [] });
    expect(payload.state === 'ready' ? payload.devices : []).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: 'ev-1', kind: 'ev_soc' }),
    ]));

    const result = app.createDeferredObjective('ev-1', {
      kind: 'ev_soc',
      enforcement: 'soft',
      targetPercent: 80,
      deadlineAtMs: Date.now() + 6 * 60 * 60 * 1000,
    });
    expect(result).toEqual({ ok: true });
    expect(readStored().objectivesByDeviceId['ev-1']).toMatchObject({ enabled: true, kind: 'ev_soc' });
    await app.onUninit?.();
  });

  // The create-smart-task widget's opt-in "Extra permissions" ride the candidate;
  // the app re-gates them against the device (defence-in-depth) so a tampered or
  // stale client can never persist a permission the device can't honour.
  describe('extra-permissions gate (create)', () => {
    const withRescue = (
      rescue: DeferredObjectivePlanPreviewCandidate['rescue'],
    ): DeferredObjectivePlanPreviewCandidate => ({ ...tempCandidate(60), rescue });

    it('persists both permissions for a stepped device with budget exemption', async () => {
      const app = await initApp({ stepped: true });
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
      // Seed the grant while the device still reads as a stepper, then let the
      // next refresh read it as non-stepped (its saved ladder is gone): the gate
      // takes the same path as in that post-restart window.
      const app = await initApp({ stepped: true });
      app.createDeferredObjective(
        'heater-1',
        withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
        'replace',
      );
      mockHomeyInstance.settings.set(DEVICE_CONTROL_PROFILES, {});
      await app.refreshTargetDevicesSnapshot();
      expect(app.getPlanInputSnapshot().find((device: { id: string }) => device.id === 'heater-1'))
        .toMatchObject({ controlModel: 'temperature_target' });
      const result = app.createDeferredObjective(
        'heater-1',
        withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
        'replace',
      );
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue)
        .toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' });
      await app.onUninit?.();
    });

    it('KEEPS a limit grant when its budget exemption is revoked', async () => {
      // The two permissions are independent: the runtime honours the limit
      // grant alone, so revoking the exemption must not take it along.
      const app = await initApp({ stepped: true });
      app.createDeferredObjective(
        'heater-1',
        withRescue({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' }),
        'replace',
      );
      expect(readStored().objectivesByDeviceId['heater-1'].rescue)
        .toEqual({ exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' });

      const result = app.createDeferredObjective(
        'heater-1',
        withRescue({ limitLowerPriorityDevices: 'always' }),
        'replace',
      );
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue)
        .toEqual({ limitLowerPriorityDevices: 'always' });
      await app.onUninit?.();
    });

    it('KEEPS a standing Flow-granted limit-only grant across a goal-only edit', async () => {
      // The Flow card is the authority on rescue and writes limit-only grants
      // verbatim; the runtime honours them (`limitLowerPriorityApplied` keys on
      // the grant alone). The editor names all three permissions on every save,
      // so a goal-only edit must carry the grant through.
      const app = await initApp({ stepped: true });
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
        'replace',
      );
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue).toEqual({ exemptFromBudget: 'always' });
      await app.onUninit?.();
    });

    it('persists a new limit-only grant on a stepped device, without the budget exemption', async () => {
      const app = await initApp({ stepped: true });
      const result = app.createDeferredObjective('heater-1', withRescue({ limitLowerPriorityDevices: 'always' }));
      expect(result).toEqual({ ok: true });
      expect(readStored().objectivesByDeviceId['heater-1'].rescue)
        .toEqual({ limitLowerPriorityDevices: 'always' });
      await app.onUninit?.();
    });

    it('KEEPS limit-lower-priority on a stepped device below top priority', async () => {
      // The gate is NOT the planner's `fullyReserved === 1` floor. Limiting
      // lower-priority devices works at any priority — swap selection already
      // refuses any candidate that is not strictly lower priority, so a boosted
      // priority-100 device can only displace something below it. Withholding the
      // grant here silently left every non-top device without the one permission
      // that clears capacity for it.
      const app = await initApp({ stepped: true, belowTopPriority: true });
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
      const app = await initApp({ stepped: true, belowTopPriority: true });
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
      const app = await initAppWithPickerOnlyHeater();
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
