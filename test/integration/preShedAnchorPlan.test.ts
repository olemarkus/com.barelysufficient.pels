import { createTestCapacityGuard } from '../helpers/createTestCapacityGuard';
import { PlanBuilder } from '../../lib/plan/planBuilder';
import { createPlanEngineState } from '../../lib/plan/planState';
import { createInMemoryPreShedAnchorStore, type PreShedAnchorStore } from '../../lib/plan/preShedAnchor';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';
import type { DevicePlan, PlanInputDevice } from '../../lib/plan/planTypes';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import {
  createPreShedAnchorStore,
  type PreShedAnchorSettingsPort,
} from '../../setup/preShedAnchorStoreAdapter';
import { seedMissingModeTargets } from '../../setup/appDeviceSupport';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES, MODE_DEVICE_TARGETS } from '../../lib/utils/settingsKeys';

/**
 * Pre-shed anchor lifecycle through the REAL plan pipeline (`PlanBuilder`),
 * for the install the two TODO bugs hit: a managed heater with NO configured
 * mode target (`getModeDeviceTargets` → `{}`), whose only restore anchor used
 * to be its live setpoint — which, while shed, IS the shed setpoint.
 */

const SHED_FLOOR_C = 16;
const USER_SETPOINT_C = 21;

const buildHeater = (params: { currentTarget: number; currentDrawKw: number; on?: boolean }): PlanInputDevice =>
  buildPlanInputDevice({
    id: 'heater',
    name: 'Panel heater',
    deviceType: 'temperature',
    deviceClass: 'heater',
    controllable: true,
    available: true,
    commandableNow: true,
    binaryControl: { on: params.on ?? true },
    expectedPowerKw: 1,
    currentDrawKw: params.currentDrawKw,
    currentTarget: params.currentTarget,
    currentTemperature: 19,
    plannedTarget: params.currentTarget,
    targets: [{ id: 'target_temperature', value: params.currentTarget, unit: '°C', min: 5, max: 35, step: 0.5 }],
  });

const plannedTargetOf = (plan: DevicePlan): number | undefined => {
  const device = plan.devices.find((dev) => dev.id === 'heater');
  return device && isTemperaturePlanDevice(device) ? device.plannedTarget : undefined;
};

const plannedStateOf = (plan: DevicePlan): string | undefined =>
  plan.devices.find((dev) => dev.id === 'heater')?.plannedState;

const restoreStampOf = (plan: DevicePlan): boolean | undefined =>
  plan.devices.find((dev) => dev.id === 'heater')?.recordRestoreOnTargetApply;

describe('pre-shed anchor through the plan pipeline', () => {
  const BASE_MS = new Date('2026-08-25T10:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildBuilder(
    state: ReturnType<typeof createPlanEngineState>,
    housePowerKw: number,
    configuredFloorC = SHED_FLOOR_C,
    behaviorAction: 'set_temperature' | 'turn_off' = 'set_temperature',
    dryRun = false,
  ): PlanBuilder {
    return new PlanBuilder({
      getCapacityDryRun: () => dryRun,
      setCapacityInShortfall: vi.fn(),
      capacityGuard: createTestCapacityGuard({ homeId: 'main' }),
      getCapacitySettings: () => ({ limitKw: 5, marginKw: 0 }),
      getOperatingMode: () => 'Home',
      // The bug's precondition: no mode target was ever configured.
      getModeDeviceTargets: () => ({}),
      getPriceOptimizationEnabled: () => false,
      getPriceOptimizationSettings: () => ({}),
      getCurrentHourPriceLevel: () => ({ cheap: false, expensive: false }),
      getPowerTracker: () => ({ lastTimestamp: Date.now(), lastPowerW: housePowerKw * 1000 }),
      getDailyBudgetSnapshot: () => null,
      getPriorityForDevice: () => 100,
      getDynamicSoftLimitOverride: () => null,
      getShedBehavior: () => (behaviorAction === 'set_temperature'
        ? { action: 'set_temperature' as const, temperature: configuredFloorC }
        : { action: 'turn_off' as const }),
      log: vi.fn(),
      logDebug: vi.fn(),
      pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
    }, state);
  }

  async function shedTheHeater(
    state: ReturnType<typeof createPlanEngineState>,
  ): Promise<DevicePlan> {
    // House at 7 kW against a 5 kW cap; the heater draws 2 kW and is the only
    // sheddable device.
    return buildBuilder(state, 7).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: USER_SETPOINT_C, currentDrawKw: 2 }),
    ]);
  }

  it('captures the anchor when the shed is decided, and releases TO it (not to the shed floor)', async () => {
    const anchors = createInMemoryPreShedAnchorStore();
    const state = createPlanEngineState(Date.now(), undefined, anchors);

    const shedPlan = await shedTheHeater(state);
    expect(plannedStateOf(shedPlan)).toBe('shed');
    expect(plannedTargetOf(shedPlan)).toBe(SHED_FLOOR_C);
    expect(anchors.read('heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: USER_SETPOINT_C, shedFloorC: SHED_FLOOR_C },
    });

    // The shed write landed (observed setpoint now 16). Ten minutes later the
    // house is far under the cap: this build detects the recovery and starts
    // the 60 s shed cooldown — the heater stays held at the floor for now, and
    // the anchor debt stands.
    vi.setSystemTime(BASE_MS + 10 * 60 * 1000);
    const recoveryPlan = await buildBuilder(state, 1).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: SHED_FLOOR_C, currentDrawKw: 0.3 }),
    ]);
    expect(plannedStateOf(recoveryPlan)).toBe('shed');
    expect(anchors.read('heater').kind).toBe('anchored');

    // Past the cooldown the heater is released. Without the anchor the
    // fallback seed read the live (shed) setpoint back, the release write was
    // a no-op, and the heater stayed at 16°C forever.
    vi.setSystemTime(BASE_MS + 12 * 60 * 1000);
    const releasePlan = await buildBuilder(state, 1).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: SHED_FLOOR_C, currentDrawKw: 0.3 }),
    ]);
    expect(plannedStateOf(releasePlan)).toBe('keep');
    expect(plannedTargetOf(releasePlan)).toBe(USER_SETPOINT_C);
    // Still parked at the floor until the release write lands: the debt stands.
    expect(anchors.read('heater').kind).toBe('anchored');

    // The release write landed: the anchor is settled and cleared.
    vi.setSystemTime(BASE_MS + 13 * 60 * 1000);
    const settledPlan = await buildBuilder(state, 1).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: USER_SETPOINT_C, currentDrawKw: 0.9 }),
    ]);
    expect(plannedTargetOf(settledPlan)).toBe(USER_SETPOINT_C);
    expect(anchors.read('heater')).toEqual({ kind: 'none' });
  });

  it('still releases to the anchor after a restart (fresh plan state, same store)', async () => {
    // The in-memory shed state dies with the process; a fresh PlanEngineState
    // over a surviving store must still know the real target. (This spec
    // isolates the planner side by sharing an in-memory store; the composed
    // spec below proves the same through the persisted adapter.)
    const anchors = createInMemoryPreShedAnchorStore();
    const state = createPlanEngineState(Date.now(), undefined, anchors);
    await shedTheHeater(state);

    // Restart 15 minutes later: new state, heater observed at the shed floor.
    vi.setSystemTime(BASE_MS + 15 * 60 * 1000);
    const rebooted = createPlanEngineState(Date.now(), undefined, anchors);
    const plan = await buildBuilder(rebooted, 1).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: SHED_FLOOR_C, currentDrawKw: 0.3 }),
    ]);

    expect(plannedTargetOf(plan)).toBe(USER_SETPOINT_C);
  });

  it('does not clobber the anchor when the post-restart build re-decides the shed', async () => {
    // First build after a restart while STILL over cap: the shed-decision edge
    // fires again for a heater already parked at its floor. The persisted
    // anchor (21°C) must win over the observed (shed) setpoint.
    const anchors = createInMemoryPreShedAnchorStore();
    const state = createPlanEngineState(Date.now(), undefined, anchors);
    await shedTheHeater(state);

    vi.setSystemTime(BASE_MS + 15 * 60 * 1000);
    const rebooted = createPlanEngineState(Date.now(), undefined, anchors);
    await buildBuilder(rebooted, 7).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: SHED_FLOOR_C, currentDrawKw: 2 }),
    ]);

    expect(anchors.read('heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: USER_SETPOINT_C, shedFloorC: SHED_FLOOR_C },
    });
  });

  it('respects a manual setpoint change after release instead of reverting it', async () => {
    const anchors = createInMemoryPreShedAnchorStore();
    const state = createPlanEngineState(Date.now(), undefined, anchors);
    await shedTheHeater(state);

    // Recovery detected (heater still at the floor, shed cooldown running).
    vi.setSystemTime(BASE_MS + 10 * 60 * 1000);
    await buildBuilder(state, 1).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: SHED_FLOOR_C, currentDrawKw: 0.3 }),
    ]);

    // Past the cooldown, but before any release write lands a person sets
    // 18°C. The live value left the captured floor, so it is the truth again:
    // the plan holds the manual choice and the settled anchor clears.
    vi.setSystemTime(BASE_MS + 12 * 60 * 1000);
    const plan = await buildBuilder(state, 1).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: 18, currentDrawKw: 0.9 }),
    ]);

    expect(plannedTargetOf(plan)).toBe(18);
    // Adopting the person's setpoint is an ordinary target hold, not a
    // restore: no restore clocks may stamp when this plan applies.
    expect(restoreStampOf(plan)).toBe(false);
    expect(anchors.read('heater')).toEqual({ kind: 'none' });
  });

  it('keeps demanding the anchor while the release write has not landed', async () => {
    // A failed/slow release write must not strand the heater: whenever the
    // restore machinery re-admits the still-at-floor device (its own cooldown
    // ladder runs between attempts), the planned target is the anchor again —
    // never the floor read back from the device.
    const anchors = createInMemoryPreShedAnchorStore();
    const state = createPlanEngineState(Date.now(), undefined, anchors);
    await shedTheHeater(state);

    // Recovery build (starts the shed cooldown), then the first admitted
    // release, then a much later retry after the first write never landed.
    vi.setSystemTime(BASE_MS + 10 * 60 * 1000);
    await buildBuilder(state, 1).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: SHED_FLOOR_C, currentDrawKw: 0.3 }),
    ]);
    for (const minutes of [12, 25]) {
      vi.setSystemTime(BASE_MS + minutes * 60 * 1000);
      const plan = await buildBuilder(state, 1).buildDevicePlanSnapshot([
        buildHeater({ currentTarget: SHED_FLOOR_C, currentDrawKw: 0.3 }),
      ]);
      expect(plannedTargetOf(plan)).toBe(USER_SETPOINT_C);
    }
    expect(anchors.read('heater').kind).toBe('anchored');
  });

  it('answers today\'s behaviour when the anchor store is unavailable', async () => {
    // Transient adapter grace after a suspect boot read: the seed falls back
    // to the live setpoint exactly as before the anchor existed — a no-op,
    // never a decision.
    const unavailable: PreShedAnchorStore = {
      read: () => ({ kind: 'unavailable' }),
      record: () => undefined,
      clear: () => undefined,
      retryDirtyPersist: () => undefined,
    };
    const state = createPlanEngineState(Date.now(), undefined, unavailable);

    vi.setSystemTime(BASE_MS + 10 * 60 * 1000);
    const plan = await buildBuilder(state, 1).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: SHED_FLOOR_C, currentDrawKw: 0.3 }),
    ]);

    expect(plannedTargetOf(plan)).toBe(SHED_FLOOR_C);
    expect(plannedStateOf(plan)).toBe('keep');
  });

  it('keeps one normalized floor per build for an off-step configured floor', async () => {
    // P1 regression: the configured floor 16.3 is off the device's 0.5 step,
    // so the capability-normalized floor (16.5) is what a fresh shed stamps,
    // what the device converges to, and what the anchor pins. Held builds
    // used to re-stamp the RAW 16.3 (an at-floor device is filtered out of
    // shed candidacy, so it carries no normalized stamp), which the anchor
    // maintenance misread as an owner floor edit: the pin flip-flopped to
    // 16.3, the at-floor gate stopped matching 16.5, and the anchor was
    // cleared while the device was still parked — both original bugs back.
    const NORMALIZED_FLOOR_C = 16.5;
    const anchors = createInMemoryPreShedAnchorStore();
    const state = createPlanEngineState(Date.now(), undefined, anchors);

    const shedPlan = await buildBuilder(state, 7, 16.3).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: USER_SETPOINT_C, currentDrawKw: 2 }),
    ]);
    expect(plannedTargetOf(shedPlan)).toBe(NORMALIZED_FLOOR_C);
    expect(anchors.read('heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: USER_SETPOINT_C, shedFloorC: NORMALIZED_FLOOR_C },
    });

    // Hold builds with the device parked at the NORMALIZED floor: the pin
    // must survive every one of them unchanged.
    for (const minutes of [2, 10]) {
      vi.setSystemTime(BASE_MS + minutes * 60 * 1000);
      const holdPlan = await buildBuilder(state, minutes === 2 ? 7 : 1, 16.3).buildDevicePlanSnapshot([
        buildHeater({ currentTarget: NORMALIZED_FLOOR_C, currentDrawKw: 0.3 }),
      ]);
      expect(plannedStateOf(holdPlan)).toBe('shed');
      expect(plannedTargetOf(holdPlan)).toBe(NORMALIZED_FLOOR_C);
      expect(anchors.read('heater')).toEqual({
        kind: 'anchored',
        entry: { anchorC: USER_SETPOINT_C, shedFloorC: NORMALIZED_FLOOR_C },
      });
    }

    // Release writes the anchor value, not the floor — and the plan stamps
    // the restore classification, so the executor stamps the restore clocks
    // (`lastRestoreMs`/`lastDeviceRestoreMs`) when the write lands. The old
    // executor-side inference compared the observation against the RAW 16.3
    // floor, never matched the normalized 16.5, and applied anchor releases
    // without ever engaging a restore cooldown.
    vi.setSystemTime(BASE_MS + 12 * 60 * 1000);
    const releasePlan = await buildBuilder(state, 1, 16.3).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: NORMALIZED_FLOOR_C, currentDrawKw: 0.3 }),
    ]);
    expect(plannedStateOf(releasePlan)).toBe('keep');
    expect(plannedTargetOf(releasePlan)).toBe(USER_SETPOINT_C);
    expect(restoreStampOf(releasePlan)).toBe(true);
    expect(anchors.read('heater').kind).toBe('anchored');

    // And the seeder never records the floor: parked at the normalized floor
    // with the anchor live, a missing mode target seeds the ANCHOR value.
    const seedStore: Record<string, unknown> = {
      [MANAGED_DEVICES]: { heater: true },
      [CONTROLLABLE_DEVICES]: { heater: true },
      [MODE_DEVICE_TARGETS]: { Home: {} },
    };
    seedMissingModeTargets({
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16.3 }),
      preShedAnchors: anchors,
      snapshot: [{
        id: 'heater',
        name: 'Panel heater',
        deviceType: 'temperature',
        available: true,
        powerCapable: true,
        expectedPowerKw: 1,
        expectedPowerSource: 'default',
        targets: [{ id: 'target_temperature', value: NORMALIZED_FLOOR_C, unit: '°C', min: 5, max: 35, step: 0.5 }],
      }],
      settings: {
        get: (key: string) => seedStore[key],
        set: (key: string, value: unknown) => {
          seedStore[key] = value;
        },
      } as never,
      debugStructured: vi.fn(),
    });
    expect(seedStore[MODE_DEVICE_TARGETS]).toEqual({ Home: { heater: USER_SETPOINT_C } });
  });

  it('releases to the anchor when a floor edit lands in the same build as release headroom', async () => {
    // The coinciding edit+release race: the owner edits the floor 16.5 -> 17
    // mid-hold; the hold lane writes 17; the FIRST build that observes 17 also
    // has release headroom. Seed resolution runs before the maintenance
    // re-pin, so with pinned-floor-only recognition the observed 17 read as a
    // manual move: the device released to 17 (not 21) and settle cleared the
    // debt. The both-floors gate resolves the anchor and keeps the debt until
    // the release write converges.
    const EDITED_FLOOR_C = 17;
    const anchors = createInMemoryPreShedAnchorStore();
    const state = createPlanEngineState(Date.now(), undefined, anchors);

    await buildBuilder(state, 7, 16.5).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: USER_SETPOINT_C, currentDrawKw: 2 }),
    ]);
    expect(anchors.read('heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: USER_SETPOINT_C, shedFloorC: 16.5 },
    });

    // Floor edited to 17 while still held: the plan writes the NEW floor, but
    // the pin keeps the old one until the device is observed there.
    vi.setSystemTime(BASE_MS + 2 * 60 * 1000);
    const editedPlan = await buildBuilder(state, 7, EDITED_FLOOR_C).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: 16.5, currentDrawKw: 0.3 }),
    ]);
    expect(plannedStateOf(editedPlan)).toBe('shed');
    expect(plannedTargetOf(editedPlan)).toBe(EDITED_FLOOR_C);
    expect(anchors.read('heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: USER_SETPOINT_C, shedFloorC: 16.5 },
    });

    // Recovery build (starts the shed cooldown); the 17-write has not landed.
    vi.setSystemTime(BASE_MS + 10 * 60 * 1000);
    await buildBuilder(state, 1, EDITED_FLOOR_C).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: 16.5, currentDrawKw: 0.3 }),
    ]);

    // THE RACE BUILD: the 17-write landed AND there is release headroom, in
    // the same build. The release must plan the anchor value, and the debt
    // must survive the build.
    vi.setSystemTime(BASE_MS + 12 * 60 * 1000);
    const racePlan = await buildBuilder(state, 1, EDITED_FLOOR_C).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: EDITED_FLOOR_C, currentDrawKw: 0.3 }),
    ]);
    expect(plannedStateOf(racePlan)).toBe('keep');
    expect(plannedTargetOf(racePlan)).toBe(USER_SETPOINT_C);
    // The floor-edit transition is still a restore: classification recognizes
    // the anchor's pinned floor, not just the current configured one.
    expect(restoreStampOf(racePlan)).toBe(true);
    expect(anchors.read('heater').kind).toBe('anchored');

    // The release write converges: the debt settles.
    vi.setSystemTime(BASE_MS + 13 * 60 * 1000);
    const settledPlan = await buildBuilder(state, 1, EDITED_FLOOR_C).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: USER_SETPOINT_C, currentDrawKw: 0.9 }),
    ]);
    expect(plannedTargetOf(settledPlan)).toBe(USER_SETPOINT_C);
    expect(anchors.read('heater')).toEqual({ kind: 'none' });
  });

  it('captures the anchor when a turn_off shed flips to set_temperature mid-hold', async () => {
    // The behaviour-flip gap: the thermostat is already in the generic shed
    // set (as a turn_off shed), so the first build that actually lowers the
    // setpoint fires NO shed-set edge. Capture keys on entry into setpoint
    // posture with an off-floor setpoint instead, so the pre-shed value is
    // recorded before the floor write can land.
    const anchors = createInMemoryPreShedAnchorStore();
    const state = createPlanEngineState(Date.now(), undefined, anchors);

    const binaryShedPlan = await buildBuilder(state, 7, SHED_FLOOR_C, 'turn_off').buildDevicePlanSnapshot([
      buildHeater({ currentTarget: USER_SETPOINT_C, currentDrawKw: 2 }),
    ]);
    expect(plannedStateOf(binaryShedPlan)).toBe('shed');
    expect(anchors.read('heater')).toEqual({ kind: 'none' });

    // The turn-off landed; the owner flips the behaviour to set_temperature.
    vi.setSystemTime(BASE_MS + 2 * 60 * 1000);
    const flippedPlan = await buildBuilder(state, 7).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: USER_SETPOINT_C, currentDrawKw: 0, on: false }),
    ]);
    expect(plannedStateOf(flippedPlan)).toBe('shed');
    expect(anchors.read('heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: USER_SETPOINT_C, shedFloorC: SHED_FLOOR_C },
    });
  });

  it('does not capture an anchor on a dry-run build; the first real shed captures the live target', async () => {
    // A dry-run build simulates the shed but `shouldApplyPlan` suppresses the
    // write — persisting an anchor for it would record a debt no device ever
    // incurred. The owner retargets during the simulation; when control goes
    // live, the first REAL shed captures the then-current setpoint.
    const anchors = createInMemoryPreShedAnchorStore();
    const state = createPlanEngineState(Date.now(), undefined, anchors);

    const dryRunPlan = await buildBuilder(state, 7, SHED_FLOOR_C, 'set_temperature', true)
      .buildDevicePlanSnapshot([buildHeater({ currentTarget: USER_SETPOINT_C, currentDrawKw: 2 })]);
    expect(plannedStateOf(dryRunPlan)).toBe('shed');
    expect(anchors.read('heater')).toEqual({ kind: 'none' });

    // Dry-run disabled; the owner retargeted to 22 meanwhile (the simulated
    // shed never lowered anything). The first real shed captures 22.
    vi.setSystemTime(BASE_MS + 2 * 60 * 1000);
    await buildBuilder(state, 7).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: 22, currentDrawKw: 2 }),
    ]);
    expect(anchors.read('heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: 22, shedFloorC: SHED_FLOOR_C },
    });
  });

  it('holds an off-step-floor device through startup stabilization after a restart', async () => {
    // The raw-floor hold-gating escape: post-restart, lastPlannedShedIds is
    // empty, and with raw-config comparisons an off-step floor (16.3 on a
    // 0.5-step device, observed at the normalized 16.5) matched nothing —
    // the device was ineligible for the hold and restored straight through
    // startup stabilization. Gating now reads the normalized floor.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: USER_SETPOINT_C, shedFloorC: 16.5 });
    const state = createPlanEngineState(Date.now(), undefined, anchors);
    state.startupRestoreBlockedUntilMs = Date.now() + 5 * 60 * 1000;

    const stabilizationPlan = await buildBuilder(state, 1, 16.3).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: 16.5, currentDrawKw: 0.3 }),
    ]);
    expect(plannedStateOf(stabilizationPlan)).toBe('shed');
    expect(plannedTargetOf(stabilizationPlan)).toBe(16.5);
    expect(anchors.read('heater').kind).toBe('anchored');

    // Stabilization over: the release plans the anchor value.
    vi.setSystemTime(BASE_MS + 10 * 60 * 1000);
    const releasePlan = await buildBuilder(state, 1, 16.3).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: 16.5, currentDrawKw: 0.3 }),
    ]);
    expect(plannedStateOf(releasePlan)).toBe('keep');
    expect(plannedTargetOf(releasePlan)).toBe(USER_SETPOINT_C);
  });

  it('survives a restart end to end through the PERSISTED adapter', async () => {
    // The full production composition: PlanBuilder over the settings-backed
    // adapter. The shed's capture write-throughs to the settings port; the
    // "restart" constructs a brand-new adapter AND plan state over the same
    // settings values — exactly what a process death leaves behind.
    const values: Record<string, unknown> = { some_unrelated_key: true };
    const port: PreShedAnchorSettingsPort = {
      get: (key) => (key in values ? values[key] : null),
      set: (key, value) => {
        values[key] = value;
      },
      getKeys: () => Object.keys(values),
    };
    const anchors = createPreShedAnchorStore(() => port, () => Date.now());
    const state = createPlanEngineState(Date.now(), undefined, anchors);
    await shedTheHeater(state);

    vi.setSystemTime(BASE_MS + 15 * 60 * 1000);
    const rebootedAnchors = createPreShedAnchorStore(() => port, () => Date.now());
    const rebootedState = createPlanEngineState(Date.now(), undefined, rebootedAnchors);
    const plan = await buildBuilder(rebootedState, 1).buildDevicePlanSnapshot([
      buildHeater({ currentTarget: SHED_FLOOR_C, currentDrawKw: 0.3 }),
    ]);

    expect(plannedTargetOf(plan)).toBe(USER_SETPOINT_C);
  });
});
