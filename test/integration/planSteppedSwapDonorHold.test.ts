import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlanCycle } from '../utils/planContextPowerFixture';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { resolvePlannedShedTargetKind } from '../../lib/plan/planActionMaterialization';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';
import { buildPlanDevice, steppedPlanDevice, applyRestorePlanForSpec } from '../utils/planTestUtils';
import { hasReservation, swapHoldersOf, swappedOutFor } from '../utils/swapLedgerFixture';
import { buildSwapCandidates } from '../../lib/plan/swap';
import type { MeteredDevicePlanDevice } from '../../lib/plan/planTypes';
import { testLogger } from '../utils/testLogger';
import { SWAP_RESERVATION_MAX_MS } from '../../lib/plan/planConstants';

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
  structuredLog: testLogger,
  powerTracker: { lastTimestamp: measurementTs } as PowerTrackerState,
  temperatureSetpoints: new Map(),
  getShedBehavior: () => ({ action: 'turn_off' as const }),
  log: vi.fn(),
});

/**
 * The target: a boosted heater on at `medium`, wanting `max` (+1 kW). It draws
 * its rung: a climb from a rung reading nothing would commit `max`'s whole
 * nameplate (`resolveStepChangeKw`).
 */
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
  currentDrawKw: reportedStepId === 'medium' ? 2 : 3,
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
    const approved = applyRestorePlanForSpec({
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
    const served = applyRestorePlanForSpec({
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
    const released = applyRestorePlanForSpec({
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
    applyRestorePlanForSpec({
      planDevices: [heater('medium'), chargerOn()],
      ...buildPlanCycle({ headroomRaw: 0.3, headroom: 0.3 }),
      state,
      sheddingActive: false,
      deps: deps(T0),
    });
    expect(swappedOutFor(state, 'charger')).toBe('heater');

    state.shedDecisions.lastPlannedShedIds = new Set(['charger']);
    vi.setSystemTime(T0 + 10_000);
    const lagging = applyRestorePlanForSpec({
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

/** A donor charger at `stepId`, drawing that step's nameplate. */
const chargerAt = (stepId: 'low' | 'medium' | 'max', currentDrawKw: number): DevicePlanDevice => steppedPlanDevice({
  id: 'charger',
  name: 'Charger',
  priority: 90,
  currentState: 'on',
  plannedState: 'keep',
  selectedStepId: stepId,
  reportedStepId: stepId,
  desiredStepId: stepId,
  currentDrawKw,
});

describe('stepped swap donor step-down', () => {
  it('lowers a stepped donor to the gentlest step that funds the swap, and holds it there until the swap settles', () => {
    // Production, 2026-11-01: a charger at 14 A was switched off to start a
    // higher-priority water heater when stepping it to 6 A freed enough. Each
    // stop cost the charger about five minutes before it drew again.
    const state = createPlanEngineState();

    // Cycle 1: 0.5 kW available, the heater needs +1 kW. The charger stepping
    // from `max` to `medium` frees 1 kW, enough with the swap reserve.
    vi.setSystemTime(T0);
    const approved = applyRestorePlanForSpec({
      planDevices: [heater('medium'), chargerAt('max', 3)],
      ...buildPlanCycle({ headroomRaw: 0.5, headroom: 0.5 }),
      state,
      sheddingActive: false,
      deps: deps(T0),
    });
    expect(swappedOutFor(state, 'charger')).toBe('heater');
    expect(byId(approved.planDevices, 'charger')).toMatchObject({
      plannedState: 'shed',
      desiredStepId: 'medium',
      plannedShedStepId: 'medium',
      reason: { code: PLAN_REASON_CODES.swappedOut, targetName: 'Water heater' },
    });
    // The end state the executor acts on: running at a lower step, not off.
    const parked = byId(approved.planDevices, 'charger');
    expect(parked && resolvePlannedShedTargetKind(parked)).toBe('step');

    // Cycle 2: the charger still reads `max`. It is held at `medium`, not
    // switched off, and the heater waits for the step-down to land.
    state.shedDecisions.lastPlannedShedIds = new Set(['charger']);
    vi.setSystemTime(T0 + 10_000);
    const lagging = applyRestorePlanForSpec({
      planDevices: [heater('medium'), chargerAt('max', 3)],
      ...buildPlanCycle({ headroomRaw: 0.5, headroom: 0.5 }),
      state,
      sheddingActive: false,
      deps: deps(T0 + 10_000),
    });
    expect(byId(lagging.planDevices, 'charger')).toMatchObject({
      plannedState: 'shed',
      desiredStepId: 'medium',
      plannedShedStepId: 'medium',
    });
    expect(byId(lagging.planDevices, 'heater')).toMatchObject({
      desiredStepId: 'medium',
      reason: { code: PLAN_REASON_CODES.swapPending },
    });

    // Cycle 3, inside the swap's served window: the charger reports `medium`
    // and a fresh reading shows the freed power. The heater steps up; the charger stays at `medium`, still running.
    vi.setSystemTime(T0 + 40_000);
    const served = applyRestorePlanForSpec({
      planDevices: [heater('medium'), chargerAt('medium', 2)],
      ...buildPlanCycle({ headroomRaw: 1.5, headroom: 1.5 }),
      state,
      sheddingActive: false,
      deps: deps(T0 + 40_000),
    });
    expect(byId(served.planDevices, 'heater')?.desiredStepId).toBe('max');
    expect(byId(served.planDevices, 'charger')).toMatchObject({ plannedState: 'shed', desiredStepId: 'medium' });

    // Cycle 4: the heater reports `max`, so the swap settles and the charger is
    // free to climb again on its own merits.
    vi.setSystemTime(T0 + 50_000);
    applyRestorePlanForSpec({
      planDevices: [heater('max'), chargerAt('medium', 2)],
      ...buildPlanCycle({ headroomRaw: 1.5, headroom: 1.5 }),
      state,
      sheddingActive: false,
      deps: deps(T0 + 50_000),
    });
    expect(hasReservation(state, 'heater')).toBe(false);
  });

  it('still switches a stepped donor off when no lower step frees enough', () => {
    // `medium` -> `low` frees 0.75 kW; with 0.3 kW available the heater's
    // +1 kW step needs more, so the charger is switched off as before.
    const state = createPlanEngineState();
    vi.setSystemTime(T0);
    const approved = applyRestorePlanForSpec({
      planDevices: [heater('medium'), chargerAt('medium', 2)],
      ...buildPlanCycle({ headroomRaw: 0.3, headroom: 0.3 }),
      state,
      sheddingActive: false,
      deps: deps(T0),
    });
    expect(swappedOutFor(state, 'charger')).toBe('heater');
    const charger = byId(approved.planDevices, 'charger');
    expect(charger).toMatchObject({
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.swappedOut, targetName: 'Water heater' },
    });
    expect(charger && resolvePlannedShedTargetKind(charger)).toBe('binary_off');
  });

  it('switches an EV donor off when its car draws less than the step, rather than count power a lower step would not free', () => {
    // The charger is at `max` (3 kW nameplate) but the car takes 1.5 kW, as
    // near full. `medium` (2 kW nameplate) would not lower that draw, so it
    // frees nothing sure, and the heater's +1 kW needs the stop.
    const state = createPlanEngineState();
    vi.setSystemTime(T0);
    const approved = applyRestorePlanForSpec({
      planDevices: [heater('medium'), { ...chargerAt('max', 1.5), isEvCharger: true }],
      ...buildPlanCycle({ headroomRaw: 0.5, headroom: 0.5 }),
      state,
      sheddingActive: false,
      deps: deps(T0),
    });
    expect(swappedOutFor(state, 'charger')).toBe('heater');
    const charger = byId(approved.planDevices, 'charger');
    expect(charger && resolvePlannedShedTargetKind(charger)).toBe('binary_off');
  });

  it('lets a swap lapse when its donor\'s step-down never reports, and starts again from what the donor reports', () => {
    const state = createPlanEngineState();
    vi.setSystemTime(T0);
    applyRestorePlanForSpec({
      planDevices: [heater('medium'), chargerAt('max', 3)],
      ...buildPlanCycle({ headroomRaw: 0.5, headroom: 0.5 }),
      state,
      sheddingActive: false,
      deps: deps(T0),
    });
    expect(swappedOutFor(state, 'charger')).toBe('heater');

    // The charger never reports `medium` (a stale report or a rejected command).
    state.shedDecisions.lastPlannedShedIds = new Set(['charger']);
    const lapsedAt = T0 + SWAP_RESERVATION_MAX_MS + 1;
    vi.setSystemTime(lapsedAt);
    applyRestorePlanForSpec({
      planDevices: [heater('medium'), chargerAt('max', 3)],
      ...buildPlanCycle({ headroomRaw: 0, headroom: 0 }),
      state,
      sheddingActive: false,
      deps: deps(lapsedAt),
    });
    // The held step-down is not kept past the reservation ceiling: the old
    // reservation is dropped, and the heater, still short of room, opens a
    // fresh swap priced from the charger's reported `max`.
    expect(state.swapLedger.reservationFor('heater')).toMatchObject({
      openedAtMs: lapsedAt,
      donors: new Map([['charger', { kind: 'step', stepId: 'low' }]]),
    });
  });
});

/**
 * A swap that steps a donor down leaves it drawing, and that draw is still
 * the lowest-ranked power in the house. Production scenario, 2026-11-03: a
 * water heater (priority 3) swaps a charger (priority 5) from 14 A to 6 A.
 * While its swap is open, a device ranked above both (priority 1) needs room;
 * before step-down swaps the charger was off and its draw already freed, but
 * a donor was never a swap source again, so the charger's 6 A stayed out of
 * reach while it outranked nothing.
 */
describe('a stepped-down swap donor and a higher-ranked target', () => {
  const ranked = (device: DevicePlanDevice, priority: number): DevicePlanDevice => ({ ...device, priority });
  const waterHeater = (reportedStepId: 'medium' | 'max') => ({ ...ranked(heater(reportedStepId), 3), name: 'Water heater' });
  const charger = (stepId: 'medium' | 'max', drawKw: number) => ranked(chargerAt(stepId, drawKw), 5);
  const chargerStopped = () => ranked(chargerOff(), 5);
  const firstRanked = (on: boolean) => buildPlanDevice({
    id: 'first', name: 'First', priority: 1, currentState: on ? 'on' : 'off',
    expectedPowerKw: 2.5, measuredPowerKw: on ? 2.5 : 0,
  });

  it('takes the donor further down for a target ranked above the swap that stepped it down', () => {
    const state = createPlanEngineState();

    // Cycle 1: the heater's +1 kW step steps the charger from `max` to `medium`.
    vi.setSystemTime(T0);
    applyRestorePlanForSpec({
      planDevices: [waterHeater('medium'), charger('max', 3)],
      ...buildPlanCycle({ headroomRaw: 0.5, headroom: 0.5 }),
      state,
      sheddingActive: false,
      deps: deps(T0),
    });
    expect(state.swapLedger.donorRelease('charger')).toEqual({ kind: 'step', stepId: 'medium' });

    // Cycle 2: the charger reports `medium` (its freed kW is in the reading) and
    // the first-ranked device needs 2.5 kW. Only the charger stopping makes room.
    state.shedDecisions.lastPlannedShedIds = new Set(['charger', 'first']);
    vi.setSystemTime(T0 + 40_000);
    const taken = applyRestorePlanForSpec({
      planDevices: [waterHeater('medium'), charger('medium', 2), firstRanked(false)],
      ...buildPlanCycle({ headroomRaw: 1.5, headroom: 1.5 }),
      state,
      sheddingActive: false,
      deps: deps(T0 + 40_000),
    });
    expect(swapHoldersOf(state, 'charger')).toEqual(['heater', 'first']);
    // Both swaps hold it at the deeper release, and its card names the higher-ranked target.
    expect(state.swapLedger.reservationFor('heater')?.donors.get('charger')).toEqual({ kind: 'off' });
    expect(byId(taken.planDevices, 'charger')).toMatchObject({
      plannedState: 'shed', reason: { code: PLAN_REASON_CODES.swappedOut, targetName: 'First' },
    });
    expect(byId(taken.planDevices, 'charger') && resolvePlannedShedTargetKind(byId(taken.planDevices, 'charger')!))
      .toBe('binary_off');
    // The heater does not step up on the power its swap freed while the charger is still drawing.
    expect(byId(taken.planDevices, 'heater')).toMatchObject({
      desiredStepId: 'medium', reason: { code: PLAN_REASON_CODES.swapPending },
    });

    // Cycle 3: the charger is off and the first-ranked device has come on, which keeps
    // its swap's promise. The heater's swap still holds the charger off: no hold
    // raises it back to `medium` under the device that took that power.
    vi.setSystemTime(T0 + 60_000);
    const settled = applyRestorePlanForSpec({
      planDevices: [waterHeater('medium'), chargerStopped(), firstRanked(true)],
      ...buildPlanCycle({ headroomRaw: 0.8, headroom: 0.8 }),
      state,
      sheddingActive: false,
      deps: deps(T0 + 60_000),
    });
    expect(hasReservation(state, 'first')).toBe(false);
    expect(swapHoldersOf(state, 'charger')).toEqual(['heater']);
    expect(byId(settled.planDevices, 'charger')).toMatchObject({
      plannedState: 'shed', desiredStepId: 'off',
      reason: { code: PLAN_REASON_CODES.swapPending, targetName: 'Water heater' },
    });
  });

  it('leaves a stepped-down donor to its swap for a target ranked at or below that swap\'s target', () => {
    const state = createPlanEngineState();
    vi.setSystemTime(T0);
    applyRestorePlanForSpec({
      planDevices: [waterHeater('medium'), charger('max', 3)],
      ...buildPlanCycle({ headroomRaw: 0.5, headroom: 0.5 }),
      state,
      sheddingActive: false,
      deps: deps(T0),
    });
    const donor = charger('medium', 2) as MeteredDevicePlanDevice;
    const deviceMap = new Map([[waterHeater('medium').id, waterHeater('medium')], [donor.id, donor]]);
    const search = (priority: number) => buildSwapCandidates(
      buildPlanDevice({ id: 'wants-room', priority }), [donor], state.swapLedger, deviceMap, { availableKw: 1.5, phaseRoom: { kind: 'off' } }, 2.5, new Set());
    // Ranked below the heater (4), or level with it (3): the charger stays the heater's.
    expect(search(4).toShed).toEqual([]);
    expect(search(3).toShed).toEqual([]);
    // Ranked above it: the charger can be stopped.
    expect(search(2).toShed).toEqual([{ device: donor, release: { kind: 'off' } }]);
    // A donor still reporting its old step is not taken further: what it frees
    // past its step-down cannot be priced apart from what that step-down frees.
    const lagging = charger('max', 3) as MeteredDevicePlanDevice;
    expect(buildSwapCandidates(
      buildPlanDevice({ id: 'wants-room', priority: 2 }), [lagging], state.swapLedger,
      new Map([...deviceMap, [lagging.id, lagging]]), { availableKw: 0.5, phaseRoom: { kind: 'off' } }, 2.5, new Set()).toShed).toEqual([]);
  });
});
