import { describe, expect, it, vi } from 'vitest';
import { createPendingBinaryCommandStore, syncPendingBinaryCommands } from '../../lib/observer/pendingBinaryCommands';
import { buildPlannedBinaryCommand } from '../../lib/plan/planExecutionProjection';
import { NO_SHEDDING_OUTCOME } from '../../lib/plan/planState';
import { selectLastResortCut } from '../../lib/plan/shedding/lastResort';
import { PENDING_SHED_RELIEF_WINDOW_MS } from '../../lib/plan/shedding/pendingRelief';
import type { PlanSheddingResult } from '../../lib/plan/shedding/types';
import type { PhaseShedOutcome } from '../../lib/plan/phase/phaseShedPass';
import { ModePriorityCatalog } from '../../packages/shared-domain/src/settings/modePriorities';
import { fixedConfirmationWindows } from '../helpers/confirmationWindows';
import { buildMeasuredPower, buildPlanContextFixture } from '../utils/planContextPowerFixture';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { applyRestorePlanForSpec, buildPlanDevice, buildPlanInputDevice } from '../utils/planTestUtils';
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

  it('issues ON only for an owned OFF after the full maximum fits every admission axis', () => {
    const now = Date.now();
    const relay = buildPlanDevice({
      id: 'relay', unmetered: true, control: { managed: true, commandAuthority: true },
      lastResort: { maximumW: 4000 }, lastResortOwnedOffAtMs: 1, currentOn: false, commandableNow: true,
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

    expect(buildPlannedBinaryCommand({ ...relay, lastResortOwnedOffAtMs: undefined })).toBeUndefined();
    expect(buildPlannedBinaryCommand(restore(3.9))).toBeUndefined();
    expect(buildPlannedBinaryCommand(restore(5))).toMatchObject({
      deviceId: 'relay', desiredOn: true, lastResortMaximumW: 4000,
    });
  });

  it('uses a lower measured donor to make room, never another unmetered relay', () => {
    const now = Date.now();
    const target = buildPlanDevice({
      id: 'target', priority: 1, unmetered: true, control: { managed: true, commandAuthority: true },
      lastResort: { maximumW: 4000 }, lastResortOwnedOffAtMs: 1, currentOn: false, commandableNow: true,
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
