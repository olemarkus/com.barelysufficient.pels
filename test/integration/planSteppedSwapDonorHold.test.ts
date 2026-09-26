import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlanCycle } from '../utils/planContextPowerFixture';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { applyRestorePlan } from '../../lib/plan/restore';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { steppedPlanDevice } from '../utils/planTestUtils';
import { hasReservation, swappedOutFor } from '../utils/swapLedgerFixture';

/**
 * A stepped device paused to fund a swap stays paused until the swap's target
 * has taken the power.
 *
 * The binary restore lane has always held a donor (`swapLedger.blockingTarget`
 * in `restore/gating.ts`); the stepped lane only held the target. Production,
 * 2026-09-25, six times in one day: a boosted water heater (on at `medium`,
 * visited by the active-stepped loop) swapped out an EV charger. The charger
 * was paused, and on the next reading the charger was the off, shed-posture
 * candidate the restore loop visits FIRST — so it was resumed at its lowest
 * step, the one restore of the cycle, and the heater it had been paused for was
 * held by the in-cycle restore until its reservation expired unserved. The
 * charger was switched off and on for nothing.
 *
 * The same missing hold is why the swap's own marking did not survive the cycle
 * it was written in: the active-stepped loop visits the donor after the swap
 * sheds it and overwrote its `swappedOut` reason (logged as
 * `plan_reason_pair_invalid` whenever the overwrite was `shed_invariant`).
 */

let capture: LoggerCapture;
beforeEach(() => {
  vi.useFakeTimers();
  capture = captureLogger('debug', ['plan']);
});
afterEach(() => {
  capture.restore();
  vi.useRealTimers();
});

const T0 = Date.UTC(2026, 8, 25, 14, 4, 15);

const deps = (measurementTs: number) => ({
  powerTracker: { lastTimestamp: measurementTs } as PowerTrackerState,
  temperatureSetpoints: new Map(),
  getShedBehavior: () => ({ action: 'turn_off' as const }),
  log: vi.fn(),
});

/** The target: a boosted heater on at `medium`, wanting `max` (+1 kW). */
const heater = (reportedStepId: 'medium' | 'max'): DevicePlanDevice => steppedPlanDevice({
  id: 'heater',
  name: 'Water heater',
  priority: 10,
  currentState: 'on',
  plannedState: 'keep',
  boostActive: true,
  selectedStepId: reportedStepId,
  reportedStepId,
  desiredStepId: reportedStepId,
});

/** The donor: an EV charger at its lowest step, 1.25 kW. */
const chargerOn = (): DevicePlanDevice => steppedPlanDevice({
  id: 'charger',
  name: 'Charger',
  priority: 90,
  currentState: 'on',
  plannedState: 'keep',
  selectedStepId: 'low',
  reportedStepId: 'low',
  desiredStepId: 'low',
  currentDrawKw: 1.25,
});

/** The donor after the executor has actuated the swap's pause. */
const chargerOff = (): DevicePlanDevice => steppedPlanDevice({
  id: 'charger',
  name: 'Charger',
  priority: 90,
  currentState: 'off',
  plannedState: 'keep',
  selectedStepId: 'off',
  reportedStepId: 'off',
  desiredStepId: 'off',
  currentDrawKw: 0,
});

const byId = (devices: DevicePlanDevice[], id: string): DevicePlanDevice | undefined => (
  devices.find((device) => device.id === id)
);

describe('stepped swap donor hold', () => {
  it('keeps a paused stepped donor off until its target has stepped up, then lets it resume', () => {
    const state = createPlanEngineState();

    // Cycle 1: 0.3 kW available; the heater's +1 kW step is funded by pausing the charger.
    vi.setSystemTime(T0);
    const approved = applyRestorePlan({
      planDevices: [heater('medium'), chargerOn()],
      ...buildPlanCycle({ headroomRaw: 0.3, headroom: 0.3 }),
      state,
      sheddingActive: false,
      deps: deps(T0),
    });
    expect(swappedOutFor(state, 'charger')).toBe('heater');
    // The swap's own marking stands for the rest of the cycle: the
    // active-stepped loop visits the charger after the swap paused it.
    expect(byId(approved.planDevices, 'charger')).toMatchObject({
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swappedOut, targetName: 'Water heater' },
    });

    // Cycle 2: the charger is off and a fresh reading shows the freed power.
    // Enough for either device, not both — and the power was freed for the heater.
    state.shedDecisions.lastPlannedShedIds = new Set(['charger']);
    vi.setSystemTime(T0 + 90_000);
    const served = applyRestorePlan({
      planDevices: [heater('medium'), chargerOff()],
      ...buildPlanCycle({ headroomRaw: 2.1, headroom: 2.1 }),
      state,
      sheddingActive: false,
      deps: deps(T0 + 90_000),
    });
    expect(byId(served.planDevices, 'charger')).toMatchObject({
      plannedState: 'shed',
      desiredStepId: 'off',
      reason: { code: PLAN_REASON_CODES.swapPending, targetName: 'Water heater' },
    });
    expect(byId(served.planDevices, 'heater')?.desiredStepId).toBe('max');
    expect(capture.findEvents('restore_stepped_admitted')).not.toContainEqual(
      expect.objectContaining({ deviceId: 'charger' }),
    );

    // Cycle 3: the heater reports `max`, which keeps the swap's promise, so the
    // charger is released to resume on its own merits.
    vi.setSystemTime(T0 + 120_000);
    const released = applyRestorePlan({
      planDevices: [heater('max'), chargerOff()],
      ...buildPlanCycle({ headroomRaw: 2.1, headroom: 2.1 }),
      state,
      sheddingActive: false,
      deps: deps(T0 + 120_000),
    });
    expect(hasReservation(state, 'heater')).toBe(false);
    expect(byId(released.planDevices, 'charger')?.desiredStepId).toBe('low');
  });

  it('keeps the pause on a donor that still reads on at the next reading', () => {
    // The Easee takes 2-8 s to accept a write and reports the pause seconds
    // after that, so the reading after the swap can still see it charging. The
    // base plan keeps it; only the swap's hold keeps the pause.
    const state = createPlanEngineState();
    vi.setSystemTime(T0);
    applyRestorePlan({
      planDevices: [heater('medium'), chargerOn()],
      ...buildPlanCycle({ headroomRaw: 0.3, headroom: 0.3 }),
      state,
      sheddingActive: false,
      deps: deps(T0),
    });
    expect(swappedOutFor(state, 'charger')).toBe('heater');

    state.shedDecisions.lastPlannedShedIds = new Set(['charger']);
    vi.setSystemTime(T0 + 10_000);
    const lagging = applyRestorePlan({
      planDevices: [heater('medium'), chargerOn()],
      ...buildPlanCycle({ headroomRaw: 0.3, headroom: 0.3 }),
      state,
      sheddingActive: false,
      deps: deps(T0 + 10_000),
    });
    expect(byId(lagging.planDevices, 'charger')).toMatchObject({
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swappedOut, targetName: 'Water heater' },
    });
    // And the heater keeps waiting for its source rather than stepping up on
    // power the meter still shows the charger drawing.
    expect(byId(lagging.planDevices, 'heater')).toMatchObject({
      desiredStepId: 'medium',
      reason: { code: PLAN_REASON_CODES.swapPending },
    });
  });
});
