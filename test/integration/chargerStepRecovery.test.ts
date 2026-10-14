import type { DevicePlanDevice, MeteredDevicePlanDevice } from '../../lib/plan/planTypes';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { isOffSteppedRestoreCandidate } from '../../lib/plan/restore/devices';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { partialDouble } from '../helpers/partialDouble';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanCycle } from '../utils/planContextPowerFixture';
import { applyRestorePlanForSpec, steppedPlanDevice } from '../utils/planTestUtils';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

const charger = (overrides: Parameters<typeof steppedPlanDevice>[0] = {}) => steppedPlanDevice({
  id: 'charger',
  name: 'Charger',
  isEvCharger: true,
  currentState: 'on',
  selectedStepId: 'low',
  desiredStepId: 'low',
  currentDrawKw: 1.25,
  ...overrides,
});

const plan = (
  state: PlanEngineState,
  devices: MeteredDevicePlanDevice[] = [charger()],
  headroomKw = 5,
) => {
  const history = state.shedDecisions;
  history.lastPlannedDeviceIds = new Set(devices.map(({ id }) => id));
  history.lastPlannedKeptIds = new Set(devices.filter((dev) => !isOffSteppedRestoreCandidate(dev)).map(({ id }) => id));
  history.lastPlannedShedIds = new Set(devices.filter(isOffSteppedRestoreCandidate).map(({ id }) => id));
  const total = devices.reduce((sum, dev) => sum + dev.currentDrawKw, 0);
  return applyRestorePlanForSpec({
    planDevices: devices,
    ...buildPlanCycle({
      total,
      softLimit: total + headroomKw,
      capacitySoftLimit: total + headroomKw,
      headroomRaw: headroomKw,
      headroom: headroomKw,
      budgetKWh: 10,
      minutesRemaining: 30,
    }),
    state,
    sheddingActive: false,
    deps: {
      powerTracker: partialDouble<PowerTrackerState>({ lastTimestamp: Date.now() }),
      temperatureSetpoints: new Map(),
      getShedBehavior: () => ({ action: 'turn_off' }),
    },
  });
};

const deviceNamed = (devices: DevicePlanDevice[], id: string): DevicePlanDevice => {
  const device = devices.find((dev) => dev.id === id);
  if (!device) throw new Error(`Missing fixture device ${id}`);
  return device;
};

describe('EV charger current recovery after limiting', () => {
  let capture: LoggerCapture;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    capture = captureLogger('debug', ['plan']);
  });

  afterEach(() => {
    capture.restore();
    vi.useRealTimers();
  });

  it('holds an otherwise admissible increase until exactly three minutes after the reduction', () => {
    const state = createPlanEngineState();
    const reducedAtMs = Date.now() - 60_000;
    state.actuation.markShed('charger', reducedAtMs);

    let result = plan(state);
    expect(deviceNamed(result.planDevices, 'charger')).toMatchObject({
      desiredStepId: 'low',
      reason: {
        code: PLAN_REASON_CODES.cooldownRestore,
        remainingSec: 120,
        countdownStartedAtMs: reducedAtMs,
        countdownTotalSec: 180,
      },
    });
    expect(result.availableHeadroom).toBe(5);
    expect(result.restoredOneThisCycle).toBe(false);
    expect(capture.findEvent('restore_stepped_rejected')).toMatchObject({
      deviceId: 'charger',
      rejectionReason: 'recent_step_down',
      remainingSec: 120,
    });

    vi.setSystemTime(reducedAtMs + 179_999);
    result = plan(state);
    expect(deviceNamed(result.planDevices, 'charger')).toMatchObject({
      desiredStepId: 'low',
      reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 1 },
    });
    expect(capture.findEvents('restore_stepped_rejected')).toHaveLength(1);

    vi.setSystemTime(reducedAtMs + 180_000);
    result = plan(state);
    expect(deviceNamed(result.planDevices, 'charger')).toMatchObject({
      desiredStepId: 'medium',
      reason: { code: PLAN_REASON_CODES.restoreNeed },
    });
  });

  it('restarts the recovery window after another reduction', () => {
    const state = createPlanEngineState();
    const firstReductionAtMs = Date.now() - 120_000;
    state.actuation.markShed('charger', firstReductionAtMs);
    expect(deviceNamed(plan(state).planDevices, 'charger').reason).toMatchObject({ remainingSec: 60 });

    const nextReductionAtMs = Date.now();
    state.actuation.markShed('charger', nextReductionAtMs);
    vi.setSystemTime(firstReductionAtMs + 180_000);
    expect(deviceNamed(plan(state).planDevices, 'charger').reason).toMatchObject({
      code: PLAN_REASON_CODES.cooldownRestore,
      remainingSec: 120,
      countdownStartedAtMs: nextReductionAtMs,
    });

    vi.setSystemTime(nextReductionAtMs + 180_000);
    expect(deviceNamed(plan(state).planDevices, 'charger').desiredStepId).toBe('medium');
  });

  it('lets a longer global restore cooldown finish before admitting an increase', () => {
    const state = createPlanEngineState();
    const reducedAtMs = Date.now() - 180_000;
    state.actuation.markShed('charger', reducedAtMs);
    state.actuation.markRestore('other', reducedAtMs);
    state.restoreBackoff.commitCooldown({ restoreCooldownMs: 300_000, lastRestoreCooldownBumpMs: null });

    expect(deviceNamed(plan(state).planDevices, 'charger')).toMatchObject({
      desiredStepId: 'low',
      reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 120 },
    });
    vi.setSystemTime(reducedAtMs + 300_000);
    expect(deviceNamed(plan(state).planDevices, 'charger').desiredStepId).toBe('medium');
  });

  it('honors the global shed gate before showing the charger recovery hold', () => {
    const state = createPlanEngineState();
    const reducedAtMs = Date.now() - 30_000;
    state.actuation.markShed('charger', reducedAtMs);
    state.restoreBackoff.noteInstability(reducedAtMs);

    expect(deviceNamed(plan(state).planDevices, 'charger').reason).toMatchObject({
      code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30,
    });
    expect(capture.findEvents('restore_stepped_rejected')).toHaveLength(0);

    vi.setSystemTime(reducedAtMs + 60_000);
    expect(deviceNamed(plan(state).planDevices, 'charger').reason).toMatchObject({
      code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 120,
    });
  });

  it('checks headroom again once the hold expires', () => {
    const state = createPlanEngineState();
    state.actuation.markShed('charger', Date.now() - 180_000);

    expect(deviceNamed(plan(state, [charger()], 0.1).planDevices, 'charger')).toMatchObject({
      desiredStepId: 'low',
      reason: { code: PLAN_REASON_CODES.insufficientHeadroom },
    });
  });

  it.each([
    { id: 'other-charger', isEvCharger: true },
    { id: 'water-heater', isEvCharger: false },
  ])('does not hold $id while the affected charger waits', ({ id, isEvCharger }) => {
    const state = createPlanEngineState();
    state.actuation.markShed('charger', Date.now() - 120_000);
    state.actuation.markShed('water-heater', Date.now() - 120_000);

    const result = plan(state, [charger(), charger({ id, isEvCharger })]);
    expect(deviceNamed(result.planDevices, 'charger').desiredStepId).toBe('low');
    expect(deviceNamed(result.planDevices, id)).toMatchObject({
      desiredStepId: 'medium', reason: { code: PLAN_REASON_CODES.restoreNeed },
    });
  });

  it('lets an off charger activate at its lowest step using the existing gates', () => {
    const state = createPlanEngineState();
    state.actuation.markShed('charger', Date.now() - 120_000);

    const result = plan(state, [charger({
      currentState: 'off', selectedStepId: 'off', desiredStepId: 'off', currentDrawKw: 0,
    })]);
    expect(deviceNamed(result.planDevices, 'charger')).toMatchObject({
      desiredStepId: 'low', reason: { code: PLAN_REASON_CODES.restoreNeed },
    });
  });

  it('keeps ordinary step-up timing when the charger has no reduction history', () => {
    const state = createPlanEngineState();
    expect(deviceNamed(plan(state).planDevices, 'charger').desiredStepId).toBe('medium');

    state.actuation.markRestore('charger', Date.now());
    vi.advanceTimersByTime(299_999);
    expect(deviceNamed(plan(state).planDevices, 'charger').desiredStepId).toBe('low');
    vi.advanceTimersByTime(1);
    expect(deviceNamed(plan(state).planDevices, 'charger').desiredStepId).toBe('medium');
  });

  it('gives a waiting off device its turn before another active charger increase when the shared gate opens', () => {
    const state = createPlanEngineState();
    const restoredAtMs = Date.now();
    state.actuation.markRestore('charger', restoredAtMs);
    const devices = () => [
      charger({ priority: 1 }),
      charger({
        id: 'heater', isEvCharger: false, priority: 2, currentState: 'off', currentDrawKw: 0,
        selectedStepId: 'off', desiredStepId: 'off',
      }),
    ];
    vi.setSystemTime(restoredAtMs + 61_000);
    let result = plan(state, devices());
    expect(deviceNamed(result.planDevices, 'charger').desiredStepId).toBe('low');
    expect(deviceNamed(result.planDevices, 'heater').plannedState).toBe('shed');

    vi.setSystemTime(restoredAtMs + 300_000);
    result = plan(state, devices());
    expect(result.restoredOneThisCycle).toBe(true);
    expect(deviceNamed(result.planDevices, 'heater').plannedState).toBe('keep');
    expect(deviceNamed(result.planDevices, 'heater').desiredStepId).toBe('low');
    expect(deviceNamed(result.planDevices, 'charger').desiredStepId).toBe('low');
  });

  it('does not let Boost bypass the recovery hold', () => {
    const state = createPlanEngineState();
    state.actuation.markShed('charger', Date.now() - 120_000);

    expect(deviceNamed(plan(state, [charger({ boostActive: true })]).planDevices, 'charger')).toMatchObject({
      desiredStepId: 'low', reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 60 },
    });
  });
});
