import { describe, expect, it, vi } from 'vitest';
import { createPendingBinaryCommandStore, syncPendingBinaryCommands } from '../../lib/observer/pendingBinaryCommands';
import { buildExecutableDeviceIntent, buildPlannedBinaryCommand } from '../../lib/plan/planExecutionProjection';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlannedSteppedCommand } from '../../lib/plan/planSteppedCommand';
import { NO_SHEDDING_OUTCOME } from '../../lib/plan/planState';
import { selectLastResortCut } from '../../lib/plan/shedding/lastResort';
import { PENDING_SHED_RELIEF_WINDOW_MS } from '../../lib/plan/shedding/pendingRelief';
import type { PlanSheddingResult } from '../../lib/plan/shedding/types';
import type { PhaseShedOutcome } from '../../lib/plan/phase/phaseShedPass';
import { ModePriorityCatalog } from '../../packages/shared-domain/src/settings/modePriorities';
import { fixedConfirmationWindows } from '../helpers/confirmationWindows';
import { buildMeasuredPower, buildPlanContextFixture } from '../utils/planContextPowerFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { applyRestorePlanForSpec, buildPlanDevice, buildPlanInputDevice, steppedPlanDevice } from '../utils/planTestUtils';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { deviceControlSettingsFixture } from '../helpers/deviceControlSettingsFixture';
import { withDeviceConfiguration } from '../utils/planTestUtils';
import { testLogger } from '../utils/testLogger';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { partialDouble } from '../helpers/partialDouble';

const buildOrdinaryAnswer = (): PlanSheddingResult => ({
  remainingDeficitKw: 2,
  shedSet: new Set(),
  shedReasons: new Map(),
  shedStepTargets: new Map(),
  storageSetpoints: new Map(),
  outcome: NO_SHEDDING_OUTCOME,
  pendingReliefKw: 0,
});

const phaseAnswer: PhaseShedOutcome = {
  shedSet: new Set(), shedReasons: new Map(), shedStepTargets: new Map(), storageSetpoints: new Map(),
  openPhases: [], unrelievedPhase: null, additionalReliefKw: 0,
};

const runningRelay = (id: string, priority: number) => buildPlanInputDevice({
  id, priority, unmetered: true, managed: true, commandAuthority: true, commandableNow: true,
  lastResort: { maximumW: 4000 }, currentOn: true,
});

describe('last-resort relay control', () => {
  it('skips a configured relay whose accepted on/off capability is read-only', () => {
    const ctx = createAppContextMock({
      deviceControlSettings: deviceControlSettingsFixture({ lastResortDevices: { healthy: 4000, blocked: 4000 } }),
      resolveManagedState: () => true,
    });
    const now = Date.now();
    const input = (id: string, priority: number, canSetControl: boolean) => ({
      ...toPlanDevice(ctx, withDeviceConfiguration({
        id, name: id, deviceClass: 'socket', available: true, canSetControl, targets: [],
        binaryCapabilityId: 'onoff', binaryControl: { on: true },
        binaryControlObservation: {
          valid: true as const, capabilityId: 'onoff', observedCapabilityIds: ['onoff'],
          observedValue: true, observedAtMs: now, source: 'snapshot_refresh' as const,
        },
      })), priority,
    });

    const blocked = input('blocked', 2, false);
    const healthy = input('healthy', 1, true);
    expect(blocked.lastResort).toMatchObject({ maximumW: 4000 });
    expect(blocked.control.commandAuthority).toBe(false);
    expect(healthy.control.commandAuthority).toBe(true);
    const devices = [healthy, blocked];
    const pending = createPendingBinaryCommandStore({}, fixedConfirmationWindows);
    expect(selectLastResortCut(
      buildPlanContextFixture({ devices, nowTs: now }), buildMeasuredPower({ sampledAtMs: now, headroomKw: -2 }),
      createPlanEngineState(now), buildOrdinaryAnswer(), phaseAnswer, pending,
    )).toMatchObject({ deviceId: 'healthy' });
  });

  it('keeps authority over an OFF relay that starts reporting power, never over a running one', () => {
    const ctx = createAppContextMock({
      deviceControlSettings: deviceControlSettingsFixture({ lastResortDevices: { relay: 4000 } }),
      resolveManagedState: () => true,
    });
    const now = Date.now();
    const relay = (on: boolean, measuredPowerKw: number) => toPlanDevice(ctx, withDeviceConfiguration({
      id: 'relay', name: 'relay', deviceClass: 'socket', available: true, canSetControl: true, targets: [],
      binaryCapabilityId: 'onoff', binaryControl: { on }, measuredPowerKw,
      binaryControlObservation: {
        valid: true as const, capabilityId: 'onoff', observedCapabilityIds: ['onoff'],
        observedValue: on, observedAtMs: now, source: 'snapshot_refresh' as const,
      },
    }));

    const off = relay(false, 0);
    expect(off.lastResort).toMatchObject({ maximumW: 4000, observedOffAtMs: now });
    expect(off.control.commandAuthority).toBe(true);
    expect(relay(true, 1.5).control.commandAuthority).toBe(false);
  });

  it('waits for ordinary limiting and alternates cuts only after a fresh meter verdict', () => {
    const pending = createPendingBinaryCommandStore({}, fixedConfirmationWindows);
    const now = Date.now();
    const state = createPlanEngineState(now);
    const devices = [runningRelay('high', 1), runningRelay('low', 2)];
    const ordinaryAnswer = buildOrdinaryAnswer();
    const ordinaryPhaseCut = { ...phaseAnswer, shedSet: new Set(['managed-phase-load']) };
    const select = (nowTs: number, sampledAtMs = nowTs, phase = phaseAnswer) => selectLastResortCut(
      buildPlanContextFixture({ devices, nowTs }), buildMeasuredPower({ sampledAtMs, headroomKw: -2 }),
      state, ordinaryAnswer, phase, pending,
    );
    expect(select(now, now, ordinaryPhaseCut)).toBeUndefined();
    const afterSettle = now + PENDING_SHED_RELIEF_WINDOW_MS + 1;
    expect(select(afterSettle, now)).toBeUndefined();
    expect(select(afterSettle)).toMatchObject({ deviceId: 'low' });
    expect(select(afterSettle + 1)).toBeUndefined();
    const previewWindow = afterSettle + PENDING_SHED_RELIEF_WINDOW_MS + 1;
    expect(select(previewWindow)).toMatchObject({ deviceId: 'low' });
    const confirmedAt = previewWindow + PENDING_SHED_RELIEF_WINDOW_MS + 5;
    pending.recordLastResortConfirmation('low', {
      dispatchState: 'accepted', desired: false, lastResortMaximumW: 4000, startedMs: previewWindow,
      confirmationWindowMs: PENDING_SHED_RELIEF_WINDOW_MS + 5000,
    }, confirmedAt);
    expect(select(confirmedAt, confirmedAt - 1)).toBeUndefined();
    expect(select(confirmedAt + 1)).toMatchObject({ deviceId: 'high' });
  });

  it('waits through the command confirmation window before cutting a second relay', () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const commands = {};
      const pending = createPendingBinaryCommandStore(commands, fixedConfirmationWindows);
      const state = createPlanEngineState(now);
      const devices = [runningRelay('high', 1), runningRelay('low', 2)];
      const select = (nowTs: number, sampledAtMs = nowTs) => selectLastResortCut(
        buildPlanContextFixture({ devices, nowTs }), buildMeasuredPower({ sampledAtMs, headroomKw: -2 }),
        state, buildOrdinaryAnswer(), phaseAnswer, pending,
      );
      expect(select(now)).toMatchObject({ deviceId: 'low' });
      pending.record('low', { desired: false, startedMs: now, lastResortMaximumW: 4000 });
      const command = pending.peek('low')!;
      expect(command.confirmationWindowMs).toBeGreaterThan(PENDING_SHED_RELIEF_WINDOW_MS);

      const whilePendingAt = now + PENDING_SHED_RELIEF_WINDOW_MS + 1;
      vi.setSystemTime(whilePendingAt);
      expect(select(whilePendingAt)).toBeUndefined();

      const timeoutAt = now + command.confirmationWindowMs;
      vi.setSystemTime(timeoutAt);
      syncPendingBinaryCommands(pending, [], 'rebuild');
      expect(select(timeoutAt, timeoutAt - 1)).toBeUndefined();
      expect(select(timeoutAt + 1)).toMatchObject({ deviceId: 'high' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('owns only the confirmed OFF observation on the same switch generation', () => {
    const pending = createPendingBinaryCommandStore({}, fixedConfirmationWindows);
    const now = Date.now();
    const confirm = () => pending.recordLastResortConfirmation('relay', {
      dispatchState: 'accepted', desired: false, lastResortMaximumW: 4000, startedMs: now - 100,
      confirmationWindowMs: 30000, binarySwitchGeneration: 2,
    }, now);
    const observe = (observedValue: boolean, generation: number, observedAtMs = now) => syncPendingBinaryCommands(pending, [{
      id: 'relay', name: 'Relay', binarySwitchGeneration: generation,
      binaryCommandConfirmation: { state: 'observed', observedValue, observedAtMs },
    }], 'rebuild');

    expect(pending.ownsLastResortOff('relay', now, 2)).toBe(false);
    confirm();
    observe(false, 2);
    expect(pending.ownsLastResortOff('relay', now, 2)).toBe(true);
    observe(false, 2, now + 100);
    expect(pending.ownsLastResortOff('relay', now + 100, 2)).toBe(false);
    expect(pending.hasLastResortOwnership()).toBe(false);
    confirm();
    observe(true, 2, now + 100);
    observe(false, 2, now + 200);
    expect(pending.ownsLastResortOff('relay', now, 2)).toBe(false);
    confirm();
    observe(false, 3);
    expect(pending.ownsLastResortOff('relay', now, 2)).toBe(false);
  });

  it('issues ON only after the full maximum fits every admission axis', () => {
    const now = Date.now();
    const relay = buildPlanDevice({
      id: 'relay', unmetered: true, control: { managed: true, commandAuthority: true },
      lastResort: { maximumW: 4000, observedOffAtMs: 1 }, currentOn: false, commandableNow: true,
    });
    const restore = (budgetHeadroomKw: number) => applyRestorePlanForSpec({
      planDevices: [relay], context: buildPlanContextFixture({ nowTs: now }),
      power: buildMeasuredPower({
        headroomKw: budgetHeadroomKw, budgetHeadroomKw, capacityHeadroomKw: 7, gridHeadroomKw: 6,
      }),
      state: createPlanEngineState(now - 600000),
      sheddingActive: false,
      deps: {
        getShedBehavior: () => ({ action: 'turn_off' }),
        powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: now }),
        temperatureSetpoints: new Map(),
        structuredLog: testLogger,
      },
    }).planDevices[0];

    expect(buildPlannedBinaryCommand(relay)).toBeUndefined();
    expect(buildPlannedBinaryCommand(restore(3.9))).toBeUndefined();
    expect(buildPlannedBinaryCommand(restore(5))).toMatchObject({
      deviceId: 'relay', desiredOn: true, lastResortMaximumW: 4000,
    });
  });

  it('uses a lower measured donor to make room, never another unmetered relay', () => {
    const now = Date.now();
    const target = buildPlanDevice({
      id: 'target', priority: 1, unmetered: true, control: { managed: true, commandAuthority: true },
      lastResort: { maximumW: 4000, observedOffAtMs: 1 }, currentOn: false, commandableNow: true,
    });
    const otherRelay = buildPlanDevice({
      id: 'relay', priority: 2, unmetered: true, control: { managed: true, commandAuthority: true },
      lastResort: { maximumW: 7500 }, currentOn: true, commandableNow: true,
    });
    const donor = buildPlanDevice({
      id: 'donor', priority: 3, currentDrawKw: 3, control: { managed: true, commandAuthority: true },
      currentOn: true, commandableNow: true, shedAction: 'turn_off',
    });
    const { planDevices } = applyRestorePlanForSpec({
      planDevices: [target, otherRelay, donor], context: buildPlanContextFixture({ nowTs: now }),
      power: buildMeasuredPower({ headroomKw: 2, capacityHeadroomKw: 2, budgetHeadroomKw: 2 }),
      state: createPlanEngineState(now - 600000), sheddingActive: false,
      deps: {
        getShedBehavior: () => ({ action: 'turn_off' }),
        powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: now }),
        temperatureSetpoints: new Map(), structuredLog: testLogger,
      },
    });
    expect(planDevices.find(({ id }) => id === 'target')).toMatchObject({
      plannedState: 'shed', reason: { code: 'swap_pending' },
    });
    expect(planDevices.find(({ id }) => id === 'relay')?.plannedState).toBe('keep');
    expect(planDevices.find(({ id }) => id === 'donor')?.plannedState).toBe('shed');
  });

  it('pins the last-resort group and preserves its individual order', () => {
    const catalog = new ModePriorityCatalog({ Home: { ordinary: 1, high: 2, low: 3 } });
    const order = catalog.getOrder('Home', ['low', 'ordinary', 'high'], () => false, (id) => id !== 'ordinary');
    expect(['high', 'low', 'ordinary'].map(order.getPriority)).toEqual([1, 2, 3]);
  });
});

describe('last-resort restore priority', () => {
  const now = 1_800_000_000_000;
  const relay = buildPlanDevice({
    id: 'relay', priority: 1, unmetered: true, control: { managed: true, commandAuthority: true },
    lastResort: { maximumW: 6000, observedOffAtMs: now - 600000 }, lastResortOwnedOffAtMs: now - 600000,
    currentOn: false, commandableNow: true,
  });
  const smallerLoad = buildPlanDevice({
    id: 'smaller', priority: 2, currentOn: false, currentDrawKw: 0, expectedPowerKw: 2,
    control: { managed: true, commandAuthority: true }, commandableNow: true, shedAction: 'turn_off',
  });

  const plan = (headroomKw: number, options: {
    relayDevice?: DevicePlanDevice;
    otherDevice?: DevicePlanDevice;
    state?: ReturnType<typeof createPlanEngineState>;
    measurementTs?: number;
  } = {}) => {
    const { relayDevice = relay, otherDevice = smallerLoad, measurementTs = now } = options;
    const state = options.state ?? createPlanEngineState(now - 600000);
    const result = applyRestorePlanForSpec({
      planDevices: [otherDevice, relayDevice], context: buildPlanContextFixture({ nowTs: now }),
      power: buildMeasuredPower({ headroomKw, capacityHeadroomKw: headroomKw, budgetHeadroomKw: headroomKw }),
      state,
      sheddingActive: false,
      deps: {
        getShedBehavior: () => ({ action: 'turn_off' }),
        powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: measurementTs }),
        temperatureSetpoints: new Map(),
        structuredLog: testLogger,
      },
    });
    return new Map(result.planDevices.map((device) => [device.id, buildPlannedBinaryCommand(device)]));
  };

  it.each([false, true])('holds the 2 kW load with 5 kW free (previously kept: %s)', (previouslyKept) => {
    const state = createPlanEngineState(now - 600000);
    if (previouslyKept) state.shedDecisions.lastPlannedKeptIds = new Set(['smaller']);
    else state.shedDecisions.lastPlannedShedIds = new Set(['smaller']);
    const commands = plan(5, { state });
    expect(commands.get('relay')).toBeUndefined();
    expect(commands.get('smaller')).toBeUndefined();
  });

  it('lets the smaller load start when the relay maximum can never fit the admission ceiling', () => {
    const result = applyRestorePlanForSpec({
      planDevices: [smallerLoad, relay], context: buildPlanContextFixture({ nowTs: now }),
      power: buildMeasuredPower({ headroomKw: 5, capacityHeadroomKw: 5, budgetHeadroomKw: 5 }),
      state: createPlanEngineState(now - 600000),
      sheddingActive: false,
      deps: {
        getShedBehavior: () => ({ action: 'turn_off' }),
        powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: now }),
        temperatureSetpoints: new Map(),
        structuredLog: testLogger,
        admissionCeiling: { limit: 'capacity', kw: 5 },
      },
    });
    const devices = new Map(result.planDevices.map((device) => [device.id, device]));
    expect(result.lastResortPriorityHold).toBeNull();
    expect(buildPlannedBinaryCommand(devices.get('smaller')!)).toMatchObject({ deviceId: 'smaller', desiredOn: true });
    expect(buildPlannedBinaryCommand(devices.get('relay')!)).toBeUndefined();
    expect(devices.get('relay')?.reason).toEqual({
      code: 'last_resort_above_limit', maximumKw: 6, limitKw: 5, limit: 'capacity',
    });
  });

  it('starts a relay above the admission ceiling while export makes room, without holding others first', () => {
    const run = (headroomKw: number) => applyRestorePlanForSpec({
      planDevices: [smallerLoad, relay], context: buildPlanContextFixture({ nowTs: now }),
      power: buildMeasuredPower({ headroomKw, capacityHeadroomKw: headroomKw, budgetHeadroomKw: headroomKw }),
      state: createPlanEngineState(now - 600000),
      sheddingActive: false,
      deps: {
        getShedBehavior: () => ({ action: 'turn_off' }),
        powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: now }),
        temperatureSetpoints: new Map(),
        structuredLog: testLogger,
        admissionCeiling: { limit: 'grid', kw: 5 },
      },
    });
    const withExport = new Map(run(7.5).planDevices.map((device) => [device.id, device]));
    expect(buildPlannedBinaryCommand(withExport.get('relay')!)).toMatchObject({ deviceId: 'relay', desiredOn: true });
    expect(buildPlannedBinaryCommand(withExport.get('smaller')!)).toBeUndefined();
    const tight = run(6);
    const devices = new Map(tight.planDevices.map((device) => [device.id, device]));
    expect(tight.lastResortPriorityHold).toBeNull();
    expect(devices.get('relay')?.reason).toMatchObject({ code: 'last_resort_above_limit', limit: 'grid' });
    expect(buildPlannedBinaryCommand(devices.get('smaller')!)).toMatchObject({ deviceId: 'smaller', desiredOn: true });

    // A switch-off the meter has not read yet starts the settle wait; the warning stays on the relay.
    const settling = createPlanEngineState(now - 600000);
    const justOff = { ...relay, lastResort: { ...relay.lastResort!, observedOffAtMs: now - 5000 } };
    const settled = applyRestorePlanForSpec({
      planDevices: [smallerLoad, justOff], context: buildPlanContextFixture({ nowTs: now }),
      power: buildMeasuredPower({ headroomKw: 7.5, capacityHeadroomKw: 7.5, budgetHeadroomKw: 7.5 }),
      state: settling, sheddingActive: false,
      deps: {
        getShedBehavior: () => ({ action: 'turn_off' }),
        powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: now - 10000 }),
        temperatureSetpoints: new Map(), structuredLog: testLogger,
        admissionCeiling: { limit: 'grid', kw: 5 },
      },
    });
    expect(settled.planDevices.find((device) => device.id === 'relay')?.reason)
      .toMatchObject({ code: 'last_resort_above_limit' });
  });

  it('keeps the priority turn for a relay whose maximum fits the admission ceiling', () => {
    const result = applyRestorePlanForSpec({
      planDevices: [smallerLoad, relay], context: buildPlanContextFixture({ nowTs: now }),
      power: buildMeasuredPower({ headroomKw: 5, capacityHeadroomKw: 5, budgetHeadroomKw: 5 }),
      state: createPlanEngineState(now - 600000),
      sheddingActive: false,
      deps: {
        getShedBehavior: () => ({ action: 'turn_off' }),
        powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: now }),
        temperatureSetpoints: new Map(),
        structuredLog: testLogger,
        admissionCeiling: { limit: 'grid', kw: 6.6 },
      },
    });
    expect(result.lastResortPriorityHold).not.toBeNull();
    const smaller = result.planDevices.find((device) => device.id === 'smaller');
    expect(buildPlannedBinaryCommand(smaller!)).toBeUndefined();
  });

  it('starts the 6 kW relay first when 7 kW is free', () => {
    const commands = plan(7);
    expect(commands.get('relay')).toMatchObject({ deviceId: 'relay', desiredOn: true });
    expect(commands.get('smaller')).toBeUndefined();
  });

  it('starts an unowned OFF relay with no external hold', () => {
    const commands = plan(7, { relayDevice: { ...relay, lastResortOwnedOffAtMs: undefined } });
    expect(commands.get('relay')).toMatchObject({ deviceId: 'relay', desiredOn: true });
  });

  it('lets the smaller device start while the relay is held off externally', () => {
    const commands = plan(7, { relayDevice: {
      ...relay, lastResortOwnedOffAtMs: undefined, externalOffHoldActive: true,
    } });
    expect(commands.get('relay')).toBeUndefined();
    expect(commands.get('smaller')).toMatchObject({ deviceId: 'smaller', desiredOn: true });
  });

  it('only undoes a PELS shutoff after the relay gains its own power reading', () => {
    const metered = buildPlanDevice({
      id: 'relay', priority: 1, currentOn: false, currentDrawKw: 0, commandableNow: true,
      control: { managed: true, commandAuthority: true },
      lastResort: { maximumW: 6000, observedOffAtMs: now - 600000, metered: true },
      lastResortOwnedOffAtMs: now - 600000,
    });
    const ownedCommands = plan(7, { relayDevice: metered });
    expect(ownedCommands.get('relay')).toMatchObject({ desiredOn: true });
    expect(ownedCommands.get('smaller')).toBeUndefined();
    const commands = plan(7, { relayDevice: { ...metered, lastResortOwnedOffAtMs: undefined } });
    expect(commands.get('relay')).toBeUndefined();
    expect(commands.get('smaller')).toMatchObject({ desiredOn: true });
  });

  it('holds a lower-ranked relay that fits while the higher-ranked relay waits', () => {
    const otherDevice = buildPlanDevice({
      id: 'lower', priority: 2, currentOn: false, unmetered: true, commandableNow: true,
      control: { managed: true, commandAuthority: true },
      lastResort: { maximumW: 2000, observedOffAtMs: now - 600000 },
    });
    const commands = plan(5, { otherDevice });
    expect(commands.get('relay')).toBeUndefined();
    expect(commands.get('lower')).toBeUndefined();
  });

  it('keeps the smaller load off until the meter has read after the confirmed relay start', () => {
    const state = createPlanEngineState(now - 600000);
    const confirmedAt = now - 360000;
    state.actuation.markConfirmedBinaryRestore('relay', confirmedAt - 1000, confirmedAt);
    state.actuation.reserveLastResortRestore('relay', 6000, now - 60000);
    const relayDevice = { ...relay, currentOn: true, currentState: 'on' as const };
    expect(plan(5, { state, relayDevice, measurementTs: confirmedAt }).get('smaller')).toBeUndefined();
    expect(plan(5, { state, relayDevice }).get('smaller')).toMatchObject({ desiredOn: true });
  });

  it('keeps ordinary starts blocked during the uncertainty window after an unconfirmed ON', () => {
    const state = createPlanEngineState(now - 600000);
    state.actuation.noteUnconfirmedLastResortStart(now + 1000);
    const relayDevice = { ...relay, currentOn: true, currentState: 'on' as const };
    expect(plan(5, { state, relayDevice }).get('smaller')).toBeUndefined();
    expect(state.actuation.lastRestoreMs).toBeNull();
  });

  it('projects no ordinary keep-on command that could restart a device after the build', () => {
    const running = { ...smallerLoad, currentOn: true, currentState: 'on' as const };
    expect(buildExecutableDeviceIntent(running)).toMatchObject({ binary: { desiredOn: true } });
    expect(buildExecutableDeviceIntent(running, undefined, true)).not.toHaveProperty('binary');
  });

  it('waits for an ordinary start that was already in flight before the relay became eligible', () => {
    const commands = plan(7, { otherDevice: { ...smallerLoad, binaryCommandPending: true } });
    expect(commands.get('relay')).toBeUndefined();
    expect(commands.get('smaller')).toBeUndefined();
  });

  it('holds a stepped increase and keeps a step-down executable', () => {
    const stepped = steppedPlanDevice({
      selectedStepId: 'low', desiredStepId: 'max', currentOn: true, plannedState: 'keep',
    });
    expect(buildPlannedSteppedCommand(stepped, true)).toBeUndefined();
    const down = steppedPlanDevice({ ...stepped, selectedStepId: 'max', desiredStepId: 'low' });
    const command = buildPlannedSteppedCommand(down, true);
    expect(command).toMatchObject({ desired: { stepId: 'low' }, stepDirection: 'down_only' });
    expect(command).not.toHaveProperty('desiredOn');
  });
});
