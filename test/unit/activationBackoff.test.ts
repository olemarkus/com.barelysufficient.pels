import { buildPlanCycleObject, cycleArgsFor, type PlanCycle, type PlanCycleSpec } from '../utils/planContextPowerFixture';
import { type HeadroomCardDeviceLike, withHeadroomCurrentOn } from '../../lib/plan/planHeadroomSupport';
import { createPlanEngineState } from '../../lib/plan/planState';
import {
  ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
  ACTIVATION_INACTIVE_MIN_ELAPSED_MS,
  ACTIVATION_SETBACK_RESTORE_BLOCK_MS,
} from '../../lib/plan/admission/activationBackoff';
import {
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  closeActivationAttemptForShed,
  getActivationPenaltyLevel,
  getActivationRestoreBlockRemainingMs,
  recordActivationAttemptStart,
  recordActivationSetback,
  syncConfirmedRestoreAttributionState,
  syncActivationPenaltyState,
} from '../../lib/plan/admission';
import {
  OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS,
  RESTORE_COOLDOWN_MS,
  SHED_COOLDOWN_MS,
} from '../../lib/plan/planConstants';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice as baseBuildPlanDevice } from '../utils/planTestUtils';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { applyRestorePlan } from '../../lib/plan/restore';
import {
  evaluateHeadroomForDevice,
  syncHeadroomCardState,
  syncHeadroomUsageObservation,
} from '../../lib/plan/planHeadroomDevice';
import { emitActivationTransitions } from '../../lib/plan/planHeadroomState';
import { getPerfSnapshot } from '../../lib/utils/perfCounters';
import { reasonText } from '../utils/deviceReasonTestUtils';
import { buildDeviceDiagnosticsRecorderStub } from '../mocks/deviceDiagnosticsRecorder';
import { PriceLevel } from '../../lib/price/priceLevels';

// A plain, unremarkable meter reading: fixtures that only need power to be
// MEASURED say so through the reading, the way production does.
const FIXTURE_TOTAL_KW = 3;

const buildContextFields = (overrides: PlanCycleSpec = {}): PlanCycle => buildPlanCycleObject({
  devices: [],
  modeTargetCFor: (d) => d.currentTarget,
  total: FIXTURE_TOTAL_KW,
  softLimit: 0,
  capacitySoftLimit: 0,
  dailySoftLimit: null,
  budgetPaceKw: null,
  projectedExemptKw: null,
  softLimitSource: 'capacity',
  budgetReleasableHeadroomHold: false,
  budgetHeadroomKw: null,
  hourBucketKey: '2026-03-08T10',
  budgetKWh: 0,
  usedKWh: 0,
  minutesRemaining: 60,
  headroomRaw: 1,
  headroom: 1,
  restoreMarginPlanning: 0.2,
  currentHourPriceLevel: PriceLevel.UNKNOWN,
  ...overrides,
});

// Mirror the producer: unless a test pins the axes explicitly, the capacity
// axis tracks the fixture's binding headroom (capacity-bound home, no daily
// budget), so restore admissions see the same available power as before the
// per-axis ledger.
const buildContext = (overrides: PlanCycleSpec = {}): PlanCycle => buildContextFields(overrides);

const buildPlanDevice = (overrides: Partial<DevicePlanDevice> = {}): DevicePlanDevice =>
  baseBuildPlanDevice({ currentState: 'off', ...overrides });

const buildTrackedDevice = (overrides: Record<string, unknown> = {}) => ({
  id: 'dev-1',
  name: 'Heater',
  binaryControl: { on: true },
  available: true,
  expectedPowerKw: 0,
  currentDrawKw: 0,
  ...overrides,
});

describe('activation backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not synthesize fallback draw for a running device with no configured load', () => {
    // Regression: the Flow card must not credit headroom to a device that has
    // proven no draw at all — no meter, no configured demand. Headroom credit
    // must be 0 in that case.
    const state = createPlanEngineState();
    const start = Date.now();
    // Through the real producer seam, so the device carries a resolved
    // `currentDrawKw` exactly as the Flow card receives it in production. Nothing
    // reports a draw here, so it resolves to 0 and credits nothing.
    const unknownRunningDevice = withHeadroomCurrentOn({
      id: 'dev-1',
      name: 'Unknown heater',
      binaryControl: { on: true },
      available: true,
      lastFreshDataMs: start,
    });
    const decision = evaluateHeadroomForDevice({
      state,
      devices: [unknownRunningDevice],
      deviceId: 'dev-1',
      device: unknownRunningDevice,
      headroom: 0.5,
      requiredKw: 1.0,
      nowTs: start,
    });
    expect(decision?.observedKw).toBe(0);
    expect(decision?.calculatedHeadroomForDeviceKw).toBe(0.5);
    expect(decision?.allowed).toBe(false);
  });

  it('credits a running device its measured draw in headroom math', () => {
    // The card must contribute a running device's draw back into
    // `headroom + observedKw`, or it blocks legitimate activations of devices
    // already drawing the requested load.
    //
    // Was "credits a running NON-METERED device with its CONFIGURED load". There
    // is no such managed device: every device on the fleet carrying a configured
    // `settings.load` also exposes `measure_power`, so the draw is measured. The
    // card no longer re-derives one from configured demand — that was a fourth
    // copy of the producer's ladder.
    const state = createPlanEngineState();
    const start = Date.now();
    const runningNonMeteredDevice = withHeadroomCurrentOn({
      id: 'dev-1',
      name: 'Relay heater',
      binaryControl: { on: true },
      available: true,
      lastFreshDataMs: start,
      measuredPowerKw: 1.2,
      expectedPowerKw: 1.2,
    });
    const decision = evaluateHeadroomForDevice({
      state,
      devices: [runningNonMeteredDevice],
      deviceId: 'dev-1',
      device: runningNonMeteredDevice,
      headroom: 0.3,
      requiredKw: 1.2,
      nowTs: start,
    });
    expect(decision?.observedKw).toBe(1.2);
    expect(decision?.calculatedHeadroomForDeviceKw).toBeCloseTo(1.5);
    expect(decision?.allowed).toBe(true);
  });

  it('credits a stale-observation device its last reading rather than zero', () => {
    // Many Homey drivers only advance per-capability `lastUpdated` on VALUE
    // CHANGE, so a thermostat steady at setpoint falls silent for hours while
    // still on and drawing exactly what it last reported. Returning 0 for that
    // blocked legitimate activations. The longer a reading is stable, the MORE
    // trustworthy it is, not less.
    const state = createPlanEngineState();
    const start = Date.now();
    const staleStableDevice = withHeadroomCurrentOn({
      id: 'dev-1',
      name: 'Heater',
      binaryControl: { on: true },
      available: true,
      lastFreshDataMs: start - (45 * 60 * 1000),
      measuredPowerKw: 1.2,
      expectedPowerKw: 1.2,
    });
    const decision = evaluateHeadroomForDevice({
      state,
      devices: [staleStableDevice],
      deviceId: 'dev-1',
      device: staleStableDevice,
      headroom: 0.3,
      requiredKw: 1.2,
      nowTs: start,
    });
    expect(decision?.observedKw).toBe(1.2);
    expect(decision?.calculatedHeadroomForDeviceKw).toBeCloseTo(1.5);
    expect(decision?.allowed).toBe(true);
  });

  it('skips headroom credit for an unavailable device even with configured load', () => {
    // Regression: Homey reports `available === false` for devices that are
    // offline / unreachable / removed from the mesh. Crediting their declared
    // load would let activations through against capacity that the device
    // cannot actually be consuming. Mirrors `isActivelyDrawing` in
    // `lib/observer/observedPower.ts`.
    const state = createPlanEngineState();
    const start = Date.now();
    // Through the real producer seam like its sibling cases above — the `as any` this test used
    // to carry was hiding the fact that it alone skipped `withHeadroomCurrentOn` and so never
    // exercised the draw resolution it asserts against.
    const unavailableDevice = withHeadroomCurrentOn({
      id: 'dev-1',
      name: 'Offline heater',
      binaryControl: { on: true },
      available: false,
      lastFreshDataMs: start,
      expectedPowerKw: 1.5,
    });
    const decision = evaluateHeadroomForDevice({
      state,
      devices: [unavailableDevice],
      deviceId: 'dev-1',
      device: unavailableDevice,
      headroom: 0.3,
      requiredKw: 1.5,
      nowTs: start,
    });
    expect(decision?.observedKw).toBe(0);
    expect(decision?.calculatedHeadroomForDeviceKw).toBeCloseTo(0.3);
    expect(decision?.allowed).toBe(false);
  });

  it('bumps penalty only once per activation attempt', () => {
    const state = createPlanEngineState();
    const now = Date.now();

    expect(recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: now,
    })).toMatchObject({ started: true, stateChanged: true });

    const first = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now + 60 * 1000,
    });
    const second = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now + 61 * 1000,
    });

    expect(first.bumped).toBe(true);
    expect(first.penaltyLevel).toBe(1);
    expect(second.bumped).toBe(false);
    expect(second.penaltyLevel).toBe(1);
  });

  it('closes attempts quietly once the attribution window expires without clearing penalty', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60 * 1000,
    });

    const secondAttemptStart = start + 2 * 60 * 1000;
    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: secondAttemptStart,
    });

    const stuckInfo = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: secondAttemptStart + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
      observation: { available: true, currentDrawKw: 2 },
    });
    expect(stuckInfo.penaltyLevel).toBe(1);
    expect(stuckInfo.attemptOpen).toBe(false);
    expect(stuckInfo.transitions).toEqual([]);
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: secondAttemptStart + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
    })).not.toBeNull();
  });

  it('keeps attempts open inside the attribution window and closes on explicit inactive observation', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    const firstSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS - 1,
      observation: { available: true, currentDrawKw: 1.2 },
    });
    expect(firstSync.attemptOpen).toBe(true);
    expect(firstSync.transitions).toEqual([]);

    const secondSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
      observation: { available: true, currentDrawKw: 1.2 },
    });
    expect(secondSync.attemptOpen).toBe(false);
    expect(secondSync.transitions).toEqual([]);

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 2 * 60_000,
    });

    const reopenedAt = start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 2 * 60_000;
    // `currentOn: false` is the off-evidence the explicit-inactive check reads
    // (the producer-resolved on/off truth). It is declared on
    // `ActivationBackoffObservation`, so it is set directly.
    const inactiveObservation = {
      currentOn: false,
      available: true,
      currentDrawKw: 0,
    };

    // The post-actuation snapshot refresh lands ~5 s in, long before any device
    // could be seen drawing. That reading is older than the command, so it must
    // not close the attempt.
    const tooEarlySync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: reopenedAt + 5_000,
      observation: inactiveObservation,
    });
    expect(tooEarlySync.attemptOpen).toBe(true);
    expect(tooEarlySync.transitions).toEqual([]);

    const inactiveSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: reopenedAt + ACTIVATION_INACTIVE_MIN_ELAPSED_MS,
      observation: inactiveObservation,
    });
    expect(inactiveSync.attemptOpen).toBe(false);
    expect(inactiveSync.transitions).toMatchObject([{ kind: 'attempt_closed_inactive', deviceId: 'dev-1' }]);
  });

  it('closes a thermostat restore attempt at attribution-window expiry once a clean whole-home sample has been seen', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    const firstSync = syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: true,
    });
    expect(firstSync.attemptOpen).toBe(true);
    expect(state.activationAttemptByDevice['dev-1']).toMatchObject({
      cleanWholeHomeSampleAtMs: start + 10_000,
    });

    // A second clean sample mid-window does not close the attempt — we wait
    // for the full attribution window so a delayed overshoot can still
    // re-bump penalty.
    const midWindowSync = syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      wholeHomePowerSampleAtMs: start + 20_000,
      cleanWholeHomeSample: true,
    });
    expect(midWindowSync.attemptOpen).toBe(true);

    // Window expiry: syncActivationPenaltyState closes the attempt.
    const closingSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 1_000,
      observation: { available: true, currentDrawKw: 0.25 },
    });
    expect(closingSync.attemptOpen).toBe(false);
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
  });

  it('clears accumulated penalty when the cautious admission survives the full attribution window with a clean whole-home sample', () => {
    // The cautious admission proved itself: at least one clean whole-home
    // sample arrived during the window and no overshoot was attributed back
    // to this device before the window expired. Penalty releases so the next
    // admission starts at the base bar — otherwise the device carries a
    // permanent tax for a single past coincidence.
    const state = createPlanEngineState();
    const start = Date.now();

    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      lastSetbackMs: start - 60_000,
    };

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: true,
    });

    expect(getActivationPenaltyLevel(state, 'dev-1')).toBe(2);

    const closingSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 1_000,
      observation: { available: true, currentDrawKw: 0.25 },
    });

    expect(closingSync.attemptOpen).toBe(false);
    expect(closingSync.stateChanged).toBe(true);
    expect(closingSync.penaltyLevel).toBe(0);
    expect(getActivationPenaltyLevel(state, 'dev-1')).toBe(0);
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
  });

  it('clears penalty for a legitimate-zero-draw step-up that survives the window', () => {
    // A heater commanded from low to high while already at setpoint, or an
    // EV charger raised to a higher current limit when the car has stopped
    // requesting current, can correctly respond to the command and draw
    // zero additional watts. The penalty-clear gate must NOT require a
    // measured load delta — only that the household stayed safe through the
    // window. This guards against trapping legitimate-zero-draw devices in
    // permanent penalty.
    const state = createPlanEngineState();
    const start = Date.now();

    state.activationAttemptByDevice['ev-1'] = {
      penaltyLevel: 1,
      lastSetbackMs: start - 60_000,
    };

    recordActivationAttemptStart({
      state,
      deviceId: 'ev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    // Device draws zero before and after the step-up; whole-home meter is
    // clean (household stayed safe).
    syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'ev-1',
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: true,
    });

    const closingSync = syncActivationPenaltyState({
      state,
      deviceId: 'ev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 1_000,
      observation: { available: true, currentDrawKw: 0 },
    });

    expect(closingSync.attemptOpen).toBe(false);
    expect(closingSync.penaltyLevel).toBe(0);
    expect(getActivationPenaltyLevel(state, 'ev-1')).toBe(0);
    expect(state.activationAttemptByDevice['ev-1']).toBeUndefined();
  });

  it('emits an attempt_closed_by_admission transition when penalty is released at window expiry', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 3,
      lastSetbackMs: start - 60_000,
    };

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: true,
    });

    const closingSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 1_000,
      observation: { available: true, currentDrawKw: 0.25 },
    });

    expect(closingSync.transitions).toEqual([
      expect.objectContaining({
        kind: 'attempt_closed_by_admission',
        deviceId: 'dev-1',
        source: 'pels_restore',
        previousPenaltyLevel: 3,
        penaltyLevel: 0,
      }),
    ]);
  });

  it('ignores a clean whole-home sample that arrives after the attribution window has already expired', () => {
    // Stale-meter bypass guard: if the meter is stale during the entire 2-min
    // window and recovers only after the window expires, the late clean
    // sample must NOT count as evidence. Otherwise a plan-build that runs
    // syncConfirmedRestoreAttributionState (which records the late sample)
    // immediately before syncActivationPenaltyState (which closes/clears)
    // would silently release penalty in defiance of the stale-meter guard.
    const state = createPlanEngineState();
    const start = Date.now();

    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      lastSetbackMs: start - 60_000,
    };

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    // No clean sample during the window — meter stale.
    syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      wholeHomePowerSampleAtMs: null,
      cleanWholeHomeSample: false,
    });

    // First clean whole-home sample arrives after the 2-min window expired.
    const postWindowMs = start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 10_000;
    syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      wholeHomePowerSampleAtMs: postWindowMs,
      cleanWholeHomeSample: true,
    });

    // Late sample must not be recorded as within-window evidence.
    expect(state.activationAttemptByDevice['dev-1']).not.toHaveProperty('cleanWholeHomeSampleAtMs');

    const closingSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: postWindowMs + 1_000,
      observation: { available: true, currentDrawKw: 0.2 },
    });
    expect(closingSync.attemptOpen).toBe(false);
    expect(closingSync.penaltyLevel).toBe(2);
    expect(closingSync.transitions).toEqual([]);
    expect(getActivationPenaltyLevel(state, 'dev-1')).toBe(2);
  });

  it('does not clear penalty at window expiry when the main meter never produced a clean sample (stale meter)', () => {
    // Stale-meter guard: with `cleanWholeHomeSample` never true during the
    // window, "no setback fired" is not evidence of capacity compliance — the
    // overshoot attribution path can't run without a known household total.
    // Penalty must persist.
    const state = createPlanEngineState();
    const start = Date.now();

    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      lastSetbackMs: start - 60_000,
    };

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      wholeHomePowerSampleAtMs: null,
      cleanWholeHomeSample: false,
    });

    const closingSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS + 1_000,
      observation: { available: true, currentDrawKw: 0.25 },
    });

    expect(closingSync.attemptOpen).toBe(false);
    expect(closingSync.transitions).toEqual([]);
    expect(closingSync.penaltyLevel).toBe(2);
    expect(getActivationPenaltyLevel(state, 'dev-1')).toBe(2);
  });

  it('closes the attempt without clearing penalty when the device is observed inactive', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 1,
      lastSetbackMs: start - 60_000,
    };

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });

    syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: true,
    });

    const inactiveSync = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      // Past the inactive-close floor but still inside the attribution window,
      // so this exercises the inactive branch rather than the expiry branch.
      nowTs: start + ACTIVATION_INACTIVE_MIN_ELAPSED_MS + 20_000,
      // `currentOn: false` is the off-evidence the explicit-inactive check reads.
      observation: {
        currentOn: false,
        available: true,
        currentDrawKw: 0,
      },
    });
    expect(inactiveSync.attemptOpen).toBe(false);
    expect(inactiveSync.transitions).toMatchObject([{ kind: 'attempt_closed_inactive', deviceId: 'dev-1' }]);
    expect(getActivationPenaltyLevel(state, 'dev-1')).toBe(1);
  });

  it('preserves penalty when a tracked device disappears from snapshot cleanup', () => {
    const state = createPlanEngineState();
    const now = Date.now();
    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      startedMs: now,
      source: 'tracked_step_up',
    };
    state.headroomCardByDevice['dev-1'] = { lastUsageKw: 1.8 };

    expect(syncHeadroomCardState({
      state,
      devices: [],
      nowTs: now + 5_000,
      cleanupMissingDevices: true,
    })).toBe(true);

    expect(state.activationAttemptByDevice['dev-1']).toEqual({ penaltyLevel: 2 });
  });

  it('uses penalty level in restore decisions', () => {
    const state = createPlanEngineState();
    state.activationAttemptByDevice['dev-1'] = { penaltyLevel: 2 };

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          currentDrawKw: 0,
        }),
      ],
      ...cycleArgsFor(buildContext({
        headroomRaw: 2.9,
        headroom: 2.9,
      })),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        normalizedShedFloorCByDevice: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
        logDebug: vi.fn(),
      },
    });

    expect(result.restoredOneThisCycle).toBe(false);
    expect(result.planDevices[0]?.plannedState).toBe('shed');
    expect(reasonText(result.planDevices[0]?.reason)).toContain('insufficient headroom');
  });

  it('blocks restore for a cooldown window after a fresh activation setback', () => {
    const state = createPlanEngineState();
    const now = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: now - 30_000,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now - 5_000,
    });

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          currentDrawKw: 0,
        }),
      ],
      ...cycleArgsFor(buildContext({
        headroomRaw: 5,
        headroom: 5,
      })),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        normalizedShedFloorCByDevice: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
        logDebug: vi.fn(),
      },
    });

    expect(result.restoredOneThisCycle).toBe(false);
    expect(result.planDevices[0]?.plannedState).toBe('shed');
    expect(reasonText(result.planDevices[0]?.reason)).toContain('activation backoff');
  });

  it('does not record a setback once the attribution window has expired', () => {
    const state = createPlanEngineState();
    const now = Date.now();
    state.activationAttemptByDevice['dev-1'] = { penaltyLevel: 1 };

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: now - ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS - 30_000,
    });

    syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: now - 10_000,
      observation: { available: true, currentDrawKw: 0 },
    });

    const setback = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now - 5_000,
    });

    expect(setback.bumped).toBe(false);
    expect(setback.transition).toBeUndefined();
    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-1', nowTs: now }))
      .toBeNull();
  });

  it('has no cooldown before any failure, then applies a flat 5-minute cooldown at every penalty level', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-1', nowTs: start })).toBeNull();
    expect(ACTIVATION_SETBACK_RESTORE_BLOCK_MS).toBe(5 * 60 * 1000);
    expect(ACTIVATION_BACKOFF_CLEAR_WINDOW_MS).toBe(5 * 60 * 1000);

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60_000,
    });
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60_000,
    })).toBe(ACTIVATION_SETBACK_RESTORE_BLOCK_MS);

    const secondStart = start + ACTIVATION_SETBACK_RESTORE_BLOCK_MS + 61_000;
    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: secondStart,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: secondStart + 60_000,
    });
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: secondStart + 60_000,
    })).toBe(ACTIVATION_SETBACK_RESTORE_BLOCK_MS);

    const thirdStart = secondStart + ACTIVATION_SETBACK_RESTORE_BLOCK_MS + 61_000;
    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: thirdStart,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: thirdStart + 60_000,
    });
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: thirdStart + 60_000,
    })).toBe(ACTIVATION_BACKOFF_CLEAR_WINDOW_MS);

    const fourthStart = thirdStart + ACTIVATION_BACKOFF_CLEAR_WINDOW_MS + 61_000;
    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: fourthStart,
    });
    const fourthSetback = recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: fourthStart + 60_000,
    });

    expect(fourthSetback.penaltyLevel).toBe(4);
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: fourthStart + 60_000,
    })).toBe(ACTIVATION_BACKOFF_CLEAR_WINDOW_MS);
  });

  it('treats the exact cooldown expiry timestamp as unblocked', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60_000,
    });

    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60_000 + ACTIVATION_SETBACK_RESTORE_BLOCK_MS - 1,
    })).toBe(1);
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 60_000 + ACTIVATION_SETBACK_RESTORE_BLOCK_MS,
    })).toBeNull();
  });

  it('allows restore again once the activation setback window expires', () => {
    const state = createPlanEngineState();
    const now = Date.now();

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: now - ACTIVATION_SETBACK_RESTORE_BLOCK_MS - 60_000,
    });
    recordActivationSetback({
      state,
      deviceId: 'dev-1',
      nowTs: now - ACTIVATION_SETBACK_RESTORE_BLOCK_MS - 1_000,
    });

    const result = applyRestorePlan({
      planDevices: [
        buildPlanDevice({
          id: 'dev-1',
          name: 'Heater',
          currentState: 'off',
          expectedPowerKw: 2,
          currentDrawKw: 0,
        }),
      ],
      ...cycleArgsFor(buildContext({
        headroomRaw: 5,
        headroom: 5,
      })),
      state,
      sheddingActive: false,
      deps: {
        powerTracker: { lastTimestamp: 123 } as PowerTrackerState,
        normalizedShedFloorCByDevice: new Map(),
        getShedBehavior: () => ({ action: 'turn_off' as const }),
        logDebug: vi.fn(),
      },
    });

    expect(result.restoredOneThisCycle).toBe(true);
    expect(result.restoredThisCycle.has('dev-1')).toBe(true);
    expect(result.planDevices[0]?.plannedState).toBe('keep');
  });

  it('does not apply penalty level after a tracked-only rise and drop without a trusted restore', () => {
    const state = createPlanEngineState();
    const start = Date.now();

    const offDevice = {
      id: 'dev-1',
      name: 'Heater',
      binaryControl: { on: false },
      available: true,
      lastFreshDataMs: start,
      expectedPowerKw: 0,
      currentDrawKw: 0,
    };

    expect(evaluateHeadroomForDevice({
      state,
      devices: [offDevice],
      deviceId: 'dev-1',
      device: offDevice,
      headroom: 0.5,
      requiredKw: 0.1,
      nowTs: start,
    })?.penaltyLevel).toBe(0);

    const steppedUpDevice = {
      ...offDevice,
      binaryControl: { on: true },
      lastFreshDataMs: start + 60 * 1000,
      expectedPowerKw: 3.2,
      currentDrawKw: 3.2,
    };
    evaluateHeadroomForDevice({
      state,
      devices: [steppedUpDevice],
      deviceId: 'dev-1',
      device: steppedUpDevice,
      headroom: 0.3,
      requiredKw: 3.2,
      nowTs: start + 60 * 1000,
    });

    const steppedDownDevice = {
      ...steppedUpDevice,
      lastFreshDataMs: start + 2 * 60 * 1000,
      expectedPowerKw: 1,
      currentDrawKw: 1,
    };
    const setbackDecision = evaluateHeadroomForDevice({
      state,
      devices: [steppedDownDevice],
      deviceId: 'dev-1',
      device: steppedDownDevice,
      headroom: 0.3,
      requiredKw: 1.1,
      nowTs: start + 2 * 60 * 1000,
    });
    expect(setbackDecision?.cooldownSource).toBeNull();
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
    expect(setbackDecision?.allowed).toBe(true);

    const recoveredDevice = {
      ...steppedUpDevice,
      lastFreshDataMs: start + 3 * 60 * 1000,
      expectedPowerKw: 3.2,
      currentDrawKw: 3.2,
    };
    const recoveredDecision = evaluateHeadroomForDevice({
      state,
      devices: [recoveredDevice],
      deviceId: 'dev-1',
      device: recoveredDevice,
      headroom: 0.2,
      requiredKw: 3.2,
      nowTs: start + 3 * 60 * 1000 + 1,
    });

    expect(recoveredDecision?.penaltyLevel).toBe(0);
    expect(recoveredDecision?.requiredKwWithPenalty).toBe(3.2);
    expect(recoveredDecision?.allowed).toBe(true);
  });

  it('does not record an activation setback when a restore attempt later sees a tracked drop', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Heater',
        available: true,
        expectedPowerKw: 3.2,
        currentDrawKw: 3.2,
      }],
      nowTs: start,
    });

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start + 60_000,
    });

    expect(syncHeadroomUsageObservation({
      state,
      deviceId: 'dev-1',
      usageObservation: { kw: 1.0 },
      nowTs: start + 120_000,
      diagnostics,
    })).toBe(true);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledWith({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-1',
      name: 'Heater',
      nowTs: start + 120_000,
      fromKw: 3.2,
      toKw: 1,
    });
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
    expect(state.activationAttemptByDevice['dev-1']).toEqual({
      startedMs: start + 60_000,
      source: 'pels_restore',
    });
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 120_000,
    })).toBeNull();
  });

  it('emits activation transitions when only the stored device name is available', () => {
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    emitActivationTransitions(
      diagnostics,
      'Heater',
      [{
        kind: 'attempt_closed_inactive',
        deviceId: 'dev-1',
        source: 'tracked_step_up',
        penaltyLevel: 1,
        elapsedMs: 5_000,
        nowTs: Date.now(),
      }],
    );

    expect(diagnostics.recordActivationTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'attempt_closed_inactive',
        deviceId: 'dev-1',
      }),
      { name: 'Heater' },
    );
  });

  it('preserves diagnostics names for tracked step-downs without treating them as failed activations', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Heater',
        available: true,
        expectedPowerKw: 3.2,
        currentDrawKw: 3.2,
      }],
      nowTs: start,
    });

    expect(syncHeadroomUsageObservation({
      state,
      deviceId: 'dev-1',
      usageObservation: { kw: 1.0 },
      nowTs: start + 120_000,
      diagnostics,
    })).toBe(true);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledWith({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-1',
      name: 'Heater',
      nowTs: start + 120_000,
      fromKw: 3.2,
      toKw: 1,
    });
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
  });

  it('stores override usage when a direct usage observation sync runs', () => {
    const state = createPlanEngineState();

    syncHeadroomUsageObservation({
      state,
      deviceId: 'dev-1',
      usageObservation: { kw: 2.4 },
      nowTs: Date.now(),
    });

    expect(state.headroomCardByDevice['dev-1']).toMatchObject({
      lastUsageKw: 2.4,
    });
  });

  it('skips unchanged snapshot-refresh tracked usage and increments the noop counter instead of replaying churn', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [
        buildTrackedDevice({ id: 'dev-1', name: 'Heater A', expectedPowerKw: 3.2, lastFreshDataMs: start + 1_000 }),
        buildTrackedDevice({ id: 'dev-2', name: 'Heater B', expectedPowerKw: 2.4, lastFreshDataMs: start + 1_500 }),
        buildTrackedDevice({ id: 'dev-3', name: 'Heater C', expectedPowerKw: 1.8, lastFreshDataMs: start + 2_000 }),
      ],
      nowTs: start,
    });
    const before = getPerfSnapshot();

    expect(syncHeadroomCardState({
      state,
      devices: [
        buildTrackedDevice({ id: 'dev-1', name: 'Heater A', expectedPowerKw: 3.2, lastFreshDataMs: start + 4_000 }),
        buildTrackedDevice({ id: 'dev-2', name: 'Heater B', expectedPowerKw: 2.4, lastFreshDataMs: start + 4_500 }),
        buildTrackedDevice({ id: 'dev-3', name: 'Heater C', expectedPowerKw: 1.8, lastFreshDataMs: start + 5_000 }),
      ],
      nowTs: start + 5_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics,
    })).toBe(false);

    const after = getPerfSnapshot();
    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
    expect(state.headroomCardByDevice['dev-1']?.lastUsageFreshnessMs).toBe(start + 4_000);
    expect(state.headroomCardByDevice['dev-2']?.lastUsageFreshnessMs).toBe(start + 4_500);
    expect(state.headroomCardByDevice['dev-3']?.lastUsageFreshnessMs).toBe(start + 5_000);
    expect((after.counts.tracked_usage_update_skipped_noop || 0) - (before.counts.tracked_usage_update_skipped_noop || 0))
      .toBe(3);
  });

  it('ignores older tracked usage inputs when a trusted merged freshness is newer', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        currentDrawKw: 1.2,
        expectedPowerKw: 1.2,
        lastFreshDataMs: start + 5_000,
      })],
      nowTs: start,
    });
    const before = getPerfSnapshot();

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        currentDrawKw: 0.2,
        expectedPowerKw: 0.2,
        lastFreshDataMs: start + 1_000,
      })],
      nowTs: start + 6_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics,
    })).toBe(false);

    const after = getPerfSnapshot();
    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
    expect(state.headroomCardByDevice['dev-1']).toMatchObject({
      lastUsageKw: 1.2,
      lastUsageFreshnessMs: start + 5_000,
    });
    expect((after.counts.tracked_usage_update_skipped_noop || 0) - (before.counts.tracked_usage_update_skipped_noop || 0))
      .toBe(1);
  });

  it('ignores stale snapshot-refresh observations before they can close an open activation attempt', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        binaryControl: { on: true },
        currentState: 'on',
        expectedPowerKw: 1.2,
        lastFreshDataMs: start + 5_000,
      })],
      nowTs: start,
    });

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start + 6_000,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        binaryControl: { on: false },
        currentState: 'off',
        expectedPowerKw: 0,
        lastFreshDataMs: start + 1_000,
      })],
      nowTs: start + 7_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics,
    })).toBe(false);

    expect(state.activationAttemptByDevice['dev-1']).toEqual({
      startedMs: start + 6_000,
      source: 'pels_restore',
    });
    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
  });

  it('closes as inactive, not quiet, when the off reading arrives at the attribution window', () => {
    // Branch precedence: `syncActivationPenaltyState` tests inactive before
    // expiry, so an inactive observation at or past the attribution window takes
    // the inactive path (penalty preserved) rather than the quiet path (which
    // can clear it). Pinned because the elapsed floor makes an attempt more
    // likely to still be open when a late off reading lands. Pre-existing
    // ordering; whether the two paths' semantics should be reconciled is still
    // an open question.
    const state = createPlanEngineState();
    const start = Date.now();
    state.activationAttemptByDevice['dev-1'] = { penaltyLevel: 1, lastSetbackMs: start - 60_000 };
    recordActivationAttemptStart({
      state, deviceId: 'dev-1', source: 'pels_restore', nowTs: start,
    });
    syncConfirmedRestoreAttributionState({
      state,
      deviceId: 'dev-1',
      wholeHomePowerSampleAtMs: start + 10_000,
      cleanWholeHomeSample: true,
    });

    const atExpiry = syncActivationPenaltyState({
      state,
      deviceId: 'dev-1',
      nowTs: start + ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
      observation: { currentOn: false, available: true, currentDrawKw: 0 },
    });

    expect(atExpiry.transitions).toMatchObject([{ kind: 'attempt_closed_inactive', deviceId: 'dev-1' }]);
    expect(getActivationPenaltyLevel(state, 'dev-1')).toBe(1);
  });

  it('leaves the attribution-window expiry as the backstop that closes a stalled attempt', () => {
    // If the inactive-close floor ever reached the attribution window, the
    // expiry branch would become the only closer and the floor dead code — the
    // attempt could never be closed as `inactive` at all.
    expect(ACTIVATION_INACTIVE_MIN_ELAPSED_MS).toBeLessThan(ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS);
  });

  it('closes an open activation attempt on a fresh explicit inactive observation even when usage is unchanged', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        binaryControl: { on: true },
        currentState: 'on',
        expectedPowerKw: 0,
        lastFreshDataMs: start + 5_000,
      })],
      nowTs: start,
    });

    recordActivationAttemptStart({
      state,
      deviceId: 'dev-1',
      source: 'pels_restore',
      nowTs: start + 6_000,
    });

    // Typed against the real input contract rather than cast: if
    // `HeadroomCardDeviceLike` gains or renames a field, this regression must
    // fail to compile instead of quietly exercising a shape production cannot
    // produce.
    const buildOffDevice = (atMs: number): HeadroomCardDeviceLike[] => [{
      id: 'dev-1',
      name: 'Heater',
      currentOn: false,
      currentState: 'off',
      available: true,
      expectedPowerKw: 0,
      currentDrawKw: 0,
      lastFreshDataMs: atMs,
    }];

    // The post-actuation snapshot refresh reads zero draw ~1 s after the attempt
    // opened. It cannot have seen the command land, so the attempt must survive.
    syncHeadroomCardState({
      state,
      devices: buildOffDevice(start + 7_000),
      nowTs: start + 7_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics,
    });

    expect(state.activationAttemptByDevice['dev-1']?.startedMs).toBe(start + 6_000);
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();

    const closesAt = start + 6_000 + ACTIVATION_INACTIVE_MIN_ELAPSED_MS;
    expect(syncHeadroomCardState({
      state,
      devices: buildOffDevice(closesAt),
      nowTs: closesAt,
      reconciliationContext: 'snapshot_refresh',
      diagnostics,
    })).toBe(true);

    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
    expect(diagnostics.recordActivationTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'attempt_closed_inactive',
        deviceId: 'dev-1',
      }),
      { name: 'Heater' },
    );
    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
  });

  it('does not let an untrusted usage observation override a trusted merged observation', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({
        id: 'dev-1',
        name: 'Heater',
        binaryControl: { on: true },
        currentState: 'on',
        currentDrawKw: 1.2,
        expectedPowerKw: 1.2,
        lastFreshDataMs: start + 5_000,
      })],
      nowTs: start,
    });
    const before = getPerfSnapshot();

    expect(syncHeadroomUsageObservation({
      state,
      deviceId: 'dev-1',
      usageObservation: { kw: 2.4 },
      nowTs: start + 6_000,
      diagnostics,
    })).toBe(false);

    const after = getPerfSnapshot();
    expect(state.headroomCardByDevice['dev-1']).toMatchObject({
      lastUsageKw: 1.2,
      lastUsageFreshnessMs: start + 5_000,
    });
    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
    expect((after.counts.tracked_usage_update_skipped_noop || 0) - (before.counts.tracked_usage_update_skipped_noop || 0))
      .toBe(1);
  });

  it('tags snapshot-refresh tracked transitions during startup with snapshot_refresh reconciliation', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [
        buildTrackedDevice({ id: 'dev-1', name: 'Heater A', currentDrawKw: 3.2, expectedPowerKw: 3.2}),
        buildTrackedDevice({ id: 'dev-2', name: 'Heater B', currentDrawKw: 2.4, expectedPowerKw: 2.4}),
        buildTrackedDevice({ id: 'dev-3', name: 'Heater C', currentDrawKw: 1.8, expectedPowerKw: 1.8}),
      ],
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [
        buildTrackedDevice({ id: 'dev-1', name: 'Heater A', currentDrawKw: 0.8, expectedPowerKw: 0.8}),
        buildTrackedDevice({ id: 'dev-2', name: 'Heater B', currentDrawKw: 0.5, expectedPowerKw: 0.5}),
        buildTrackedDevice({ id: 'dev-3', name: 'Heater C', currentDrawKw: 0.2, expectedPowerKw: 0.2}),
      ],
      nowTs: start + 5_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics,
    })).toBe(true);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledTimes(3);
    expect(diagnostics.recordControlEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-1',
      reconciliation: 'snapshot_refresh',
    }));
    expect(diagnostics.recordControlEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-2',
      reconciliation: 'snapshot_refresh',
    }));
    expect(diagnostics.recordControlEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({
      kind: 'tracked_usage_drop',
      deviceId: 'dev-3',
      reconciliation: 'snapshot_refresh',
    }));
  });

  it('does not track target-only devices in the activation backoff lifecycle', () => {
    // Target-only devices (`not_applicable`) have no onoff capability — their
    // raw `currentOn` flag is not authoritative for binary state, so the
    // activation backoff system does not classify them as "active" and skips
    // both the tracked-rise diagnostic and the activation-attempt lifecycle.
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Nordic S4 REL',
        currentState: 'not_applicable',
        available: true,
        expectedPowerKw: 0,
        currentDrawKw: 0,
      }],
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Nordic S4 REL',
        currentState: 'not_applicable',
        available: true,
        expectedPowerKw: 1.0,
        currentDrawKw: 0,
      }],
      nowTs: start + 5_000,
      reconciliationContext: 'snapshot_refresh',
      diagnostics,
    })).toBe(false);

    expect(diagnostics.recordControlEvent).not.toHaveBeenCalled();
    expect(diagnostics.recordActivationTransition).not.toHaveBeenCalled();
    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();

    expect(syncHeadroomCardState({
      state,
      devices: [{
        id: 'dev-1',
        name: 'Nordic S4 REL',
        currentState: 'not_applicable',
        available: true,
        expectedPowerKw: 0,
        currentDrawKw: 0,
      }],
      nowTs: start + 24_000,
      diagnostics,
    })).toBe(false);

    expect(state.activationAttemptByDevice['dev-1']).toBeUndefined();
    expect(getActivationRestoreBlockRemainingMs({
      state,
      deviceId: 'dev-1',
      nowTs: start + 24_000,
    })).toBeNull();
  });

  it('tags tracked step-ups after a recent restore as post_actuation reconciliation', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    state.appStartedAtMs = start - (Math.max(SHED_COOLDOWN_MS, RESTORE_COOLDOWN_MS) + 1);
    state.lastDeviceRestoreMs['dev-1'] = start;

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()],
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, currentDrawKw: 1.0 })],
      nowTs: start + 5_000,
      diagnostics,
    })).toBe(false);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
      reconciliation: 'post_actuation',
    }));
  });

  it('leaves steady-state tracked transitions untagged outside reconciliation windows', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    state.appStartedAtMs = start - (Math.max(SHED_COOLDOWN_MS, RESTORE_COOLDOWN_MS) + 1);

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()],
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, currentDrawKw: 1.0 })],
      nowTs: start + (2 * 60 * 1000),
      diagnostics,
    })).toBe(false);

    const [event] = diagnostics.recordControlEvent.mock.calls[0];
    expect(event).toMatchObject({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
    });
    // `toMatchObject` checks the discriminant at runtime but does not narrow it for the
    // compiler, and `reconciliation` is declared only on the tracked-usage arm of the event
    // union — so the read below needs the guard to be checked at all.
    if (event.kind !== 'tracked_usage_rise') throw new Error(`expected tracked_usage_rise, got ${event.kind}`);
    expect(event.reconciliation).toBeUndefined();
  });

  it('treats the reconciliation-window boundary as inclusive', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()],
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, currentDrawKw: 1.0 })],
      nowTs: start + Math.max(SHED_COOLDOWN_MS, RESTORE_COOLDOWN_MS),
      diagnostics,
    })).toBe(false);

    expect(diagnostics.recordControlEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
      reconciliation: 'startup',
    }));
  });

  it('ends startup reconciliation when startup stabilization ends early', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    state.startupRestoreBlockedUntilMs = start + 30_000;

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()],
      nowTs: start,
    });

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, currentDrawKw: 1.0 })],
      nowTs: start + 45_000,
      diagnostics,
    })).toBe(false);

    const [event] = diagnostics.recordControlEvent.mock.calls[0];
    expect(event).toMatchObject({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
    });
    // `toMatchObject` checks the discriminant at runtime but does not narrow it for the
    // compiler, and `reconciliation` is declared only on the tracked-usage arm of the event
    // union — so the read below needs the guard to be checked at all.
    if (event.kind !== 'tracked_usage_rise') throw new Error(`expected tracked_usage_rise, got ${event.kind}`);
    expect(event.reconciliation).toBeUndefined();
  });

  it('ends startup reconciliation after startup stabilization is explicitly cleared', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    const diagnostics = buildDeviceDiagnosticsRecorderStub();

    state.startupRestoreBlockedUntilMs = start + 60_000;

    syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice()],
      nowTs: start,
    });

    state.startupRestoreBlockedUntilMs = start + 4_999;

    expect(syncHeadroomCardState({
      state,
      devices: [buildTrackedDevice({ expectedPowerKw: 1.0, currentDrawKw: 1.0 })],
      nowTs: start + 5_000,
      diagnostics,
    })).toBe(false);

    const [event] = diagnostics.recordControlEvent.mock.calls[0];
    expect(event).toMatchObject({
      kind: 'tracked_usage_rise',
      deviceId: 'dev-1',
    });
    // `toMatchObject` checks the discriminant at runtime but does not narrow it for the
    // compiler, and `reconciliation` is declared only on the tracked-usage arm of the event
    // union — so the read below needs the guard to be checked at all.
    if (event.kind !== 'tracked_usage_rise') throw new Error(`expected tracked_usage_rise, got ${event.kind}`);
    expect(event.reconciliation).toBeUndefined();
  });

  it('closes an open attempt on shed without changing the existing penalty level', () => {
    const state = createPlanEngineState();
    const start = Date.now();
    state.activationAttemptByDevice['dev-1'] = {
      penaltyLevel: 2,
      startedMs: start - 30_000,
      source: 'pels_restore',
    };

    const result = closeActivationAttemptForShed({
      state,
      deviceId: 'dev-1',
      nowTs: start,
    });

    expect(result.stateChanged).toBe(true);
    expect(result.transition).toMatchObject({
      kind: 'attempt_closed_by_shed',
      deviceId: 'dev-1',
      penaltyLevel: 2,
      source: 'pels_restore',
    });
    expect(state.activationAttemptByDevice['dev-1']).toEqual({ penaltyLevel: 2 });
  });
});

// Mirrors attributeOvershootToRecentRestores: walks recent restores newest-first and
// attributes overshoot to the first one that still has an open attempt.
const attributeOvershoot = (state: ReturnType<typeof createPlanEngineState>, nowTs: number): void => {
  const recentRestores = Object.entries(state.lastDeviceRestoreMs)
    .filter(([, restoreMs]) => nowTs - restoreMs <= OVERSHOOT_RESTORE_ATTRIBUTION_WINDOW_MS)
    .sort((left, right) => right[1] - left[1]);
  for (const [deviceId] of recentRestores) {
    const result = recordActivationSetback({ state, deviceId, nowTs });
    if (result.transition) return;
  }
};

describe('overshoot-after-restore attribution', () => {
  it('records a setback for the most recently restored device within the attribution window', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    state.lastDeviceRestoreMs['dev-a'] = nowTs - 14_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-a', source: 'pels_restore', nowTs: nowTs - 14_000 });

    attributeOvershoot(state, nowTs);

    expect(state.activationAttemptByDevice['dev-a']?.penaltyLevel).toBe(1);
    expect(state.activationAttemptByDevice['dev-a']?.lastSetbackMs).toBe(nowTs);
    const block = getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-a', nowTs });
    expect(block).not.toBeNull();
    expect(block).toBeGreaterThan(4 * 60 * 1000);
  });

  it('does not attribute overshoot to a device restored outside the attribution window', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    // Restore happened 3 minutes ago — outside the 2-minute window
    state.lastDeviceRestoreMs['dev-b'] = nowTs - 3 * 60 * 1000;
    recordActivationAttemptStart({ state, deviceId: 'dev-b', source: 'pels_restore', nowTs: nowTs - 3 * 60 * 1000 });

    attributeOvershoot(state, nowTs);

    expect(state.activationAttemptByDevice['dev-b']?.penaltyLevel).toBeUndefined();
    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-b', nowTs })).toBeNull();
  });

  it('does not attribute overshoot to a device with no open activation attempt', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    // Restore timestamp is recent but no activation attempt was started (e.g., manually turned on)
    state.lastDeviceRestoreMs['dev-c'] = nowTs - 10_000;

    attributeOvershoot(state, nowTs);

    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-c', nowTs })).toBeNull();
  });

  it('only penalizes the most recently restored device when multiple are in the window', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    // dev-earlier was restored 90s ago — within window, but not the marginal restore
    state.lastDeviceRestoreMs['dev-earlier'] = nowTs - 90_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-earlier', source: 'pels_restore', nowTs: nowTs - 90_000 });

    // dev-latest was restored 14s ago — the one that tipped headroom negative
    state.lastDeviceRestoreMs['dev-latest'] = nowTs - 14_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-latest', source: 'pels_restore', nowTs: nowTs - 14_000 });

    attributeOvershoot(state, nowTs);

    // Only dev-latest gets penalized
    expect(state.activationAttemptByDevice['dev-latest']?.penaltyLevel).toBe(1);
    expect(state.activationAttemptByDevice['dev-earlier']?.penaltyLevel).toBeUndefined();
    expect(getActivationRestoreBlockRemainingMs({ state, deviceId: 'dev-earlier', nowTs })).toBeNull();
  });

  it('falls back to an earlier open restore when the latest restore was already closed by shed', () => {
    const state = createPlanEngineState();
    const nowTs = Date.UTC(2024, 0, 1, 12, 0, 0);

    state.lastDeviceRestoreMs['dev-earlier'] = nowTs - 90_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-earlier', source: 'pels_restore', nowTs: nowTs - 90_000 });

    state.lastDeviceRestoreMs['dev-latest'] = nowTs - 14_000;
    recordActivationAttemptStart({ state, deviceId: 'dev-latest', source: 'pels_restore', nowTs: nowTs - 14_000 });
    closeActivationAttemptForShed({ state, deviceId: 'dev-latest', nowTs: nowTs - 5_000 });

    attributeOvershoot(state, nowTs);

    expect(state.activationAttemptByDevice['dev-latest']).toBeUndefined();
    expect(state.activationAttemptByDevice['dev-earlier']?.penaltyLevel).toBe(1);
  });
});
