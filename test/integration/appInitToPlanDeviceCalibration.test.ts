/**
 * Coverage for `toPlanDevice`'s calibration-view enrichment.
 *
 * `confirmedNotDrawing` is two-state by contract, and `true` is the narrow arm.
 * It requires POSITIVE evidence — a fresh meter reading below the active floor,
 * on a device PELS is not itself holding off — because sample ACCEPTANCE is EMA
 * hygiene, not an answer to "is it drawing". A charger parked on a high rung
 * while a PHEV pulls 1-2 kW records no samples at all, and reading that silence
 * as idleness released the boost on a device drawing at full rate.
 *
 * The store-side rules, unchanged:
 *   - No `reportedStepId` → `false`, even if `selectedStepId` matches a
 *     calibration entry. The resolver has no observational truth about which
 *     step the device is at, and absence of evidence is not evidence of idleness.
 *   - A recent in-band draw at ANY step → `false`, regardless of which step is
 *     currently reported — a just-stepped-up device still ramping at the
 *     previous step's level is accepting load, not idle. This is what keeps a
 *     boosted staircase climbing.
 *   - `true` requires the reported step to be calibration-confident with every
 *     step quiet: the idle-at-setpoint signature that releases a boost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import {
  createEmptyPowerCalibrationSnapshot,
  POWER_CALIBRATION_CONSTANTS,
  recordSample,
} from '../../lib/device/devicePowerCalibration';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { AppContext } from '../../lib/app/appContext';
import type {
  SteppedLoadProfile,
  DecoratedDeviceSnapshot,
  MeasuredPowerObservedProbe,
} from '../../packages/contracts/src/types';

const HOIAX_PROFILE: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const FIXED_NOW = new Date('2026-05-12T12:00:00Z').getTime();

const buildSnapshotWithMediumEntry = (): PowerCalibrationSnapshot => {
  // Seed a confident-enough entry so `hasRecentDrawAt` has a real value to
  // return; six 70 s-spaced samples cross both the sample-count and
  // sustained-seconds thresholds.
  let snapshot = createEmptyPowerCalibrationSnapshot();
  for (let i = 0; i < 6; i += 1) {
    const outcome = recordSample(snapshot, {
      deviceId: 'hoiax-1',
      stepId: 'medium',
      measuredPowerKw: 1.6,
      nameplateKw: 1.75,
      nowMs: FIXED_NOW - 6 * 70_000 + i * 70_000,
    });
    if (outcome.accepted) snapshot = outcome.snapshot;
  }
  return snapshot;
};

// The idle-at-setpoint baseline: observed ON, meter fresh, and reading zero.
// Those three are what `true` now REQUIRES — the verdict is positive evidence of
// idleness, never inferred from an absent sample — so every scenario below
// varies exactly one of them or the calibration store.
const buildDeviceSnapshot = (
  overrides: Partial<DecoratedDeviceSnapshot & MeasuredPowerObservedProbe> = {},
): DecoratedDeviceSnapshot & MeasuredPowerObservedProbe => ({
  id: 'hoiax-1',
  name: 'Hoiax',
  targets: [],
  controlModel: 'stepped_load',
  steppedLoadProfile: HOIAX_PROFILE,
  binaryControl: { on: true },
  measuredPowerKw: 0,
  measuredPowerObservedAtMs: FIXED_NOW,
  ...overrides,
}) as DecoratedDeviceSnapshot & MeasuredPowerObservedProbe;

const ctxWithSnapshot = (snapshot: PowerCalibrationSnapshot): AppContext => {
  const ctx = createAppContextMock();
  // The mock helper already wires `getPowerCalibrationSnapshot` to return an
  // empty snapshot; replace it with the seeded snapshot for this scenario.
  (ctx as unknown as { getPowerCalibrationSnapshot: () => PowerCalibrationSnapshot })
    .getPowerCalibrationSnapshot = () => snapshot;
  // Pin the clock so hasRecentDrawAt's window is deterministic.
  (ctx as unknown as { getNow: () => Date }).getNow = () => new Date(FIXED_NOW);
  return ctx;
};

describe('toPlanDevice — confirmedNotDrawing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is false when the device has no reportedStepId, even if selectedStepId has a calibration entry', () => {
    const snapshot = buildSnapshotWithMediumEntry();
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      selectedStepId: 'medium',
      // No reportedStepId → no observational truth about which step the
      // device is currently at. The resolver must NOT fall back to the
      // planner's intended step.
    }));
    expect(result.confirmedNotDrawing).toBe(false);
  });

  it('is false when reportedStepId matches a confident calibration entry inside the recent-draw window', () => {
    const snapshot = buildSnapshotWithMediumEntry();
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
    }));
    expect(result.confirmedNotDrawing).toBe(false);
  });

  it('is false when another step has recent draw, even though the reported step has no entry', () => {
    // The staircase case from prod (2026-07-05): right after a step change
    // the newly reported step has no accepted samples yet (ramp readings are
    // skipped as out-of-band) while the step it came from still holds fresh
    // in-band samples. The device is demonstrably accepting load; the resolver
    // must not read this as idle and release the boost mid-climb.
    const snapshot = buildSnapshotWithMediumEntry();
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'low',
      selectedStepId: 'low',
    }));
    expect(result.confirmedNotDrawing).toBe(false);
  });

  it('is false for a recent warm-up sample (below confidence, but real draw)', () => {
    // A single accepted sample is below the confidence threshold, but it is
    // still a recent in-band observation — evidence of draw, never a verdict of
    // idleness that would release boost for a newly paired device.
    let snapshot = createEmptyPowerCalibrationSnapshot();
    const outcome = recordSample(snapshot, {
      deviceId: 'hoiax-1',
      stepId: 'medium',
      measuredPowerKw: 1.6,
      nameplateKw: 1.75,
      nowMs: FIXED_NOW,
    });
    if (outcome.accepted) snapshot = outcome.snapshot;
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
    }));
    expect(result.confirmedNotDrawing).toBe(false);
  });

  it('is true when the reported step is confident and every step is quiet', () => {
    // Confident calibration at the reported step, but the freshest sample is
    // older than the recent-draw window at every step: the idle-at-setpoint
    // signature (e.g. a Hoiax holding at its element setpoint).
    let snapshot = createEmptyPowerCalibrationSnapshot();
    const staleBase = FIXED_NOW - 30 * 60_000;
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, {
        deviceId: 'hoiax-1',
        stepId: 'medium',
        measuredPowerKw: 1.6,
        nameplateKw: 1.75,
        nowMs: staleBase + i * 70_000,
      });
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
    }));
    expect(result.confirmedNotDrawing).toBe(true);
  });

  it('is false for a device that is measurably drawing, however quiet the store', () => {
    // The prod-shaped regression this guard exists for. `recordSample` drops a
    // reading at or below the next-lower rung's ceiling, so a charger parked on
    // a high rung while a PHEV pulls 1.4 kW accepts NO samples — every step
    // reads quiet and the rung is still confident from an earlier full-rate
    // session. Concluding idleness there released the boost on a device drawing
    // at full rate, clamped it down a rung, and then blocked the climb back
    // through the shed-invariant bypass that same release gates.
    let snapshot = createEmptyPowerCalibrationSnapshot();
    const staleBase = FIXED_NOW - 30 * 60_000;
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, {
        deviceId: 'hoiax-1',
        stepId: 'medium',
        measuredPowerKw: 1.6,
        nameplateKw: 1.75,
        nowMs: staleBase + i * 70_000,
      });
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
      measuredPowerKw: 1.4,
    }));
    expect(result.confirmedNotDrawing).toBe(false);
  });

  it('is false when the meter reading is stale, and when there is none at all', () => {
    // Absence of a METER is not zero draw either: `getCurrentDrawKw` resolves an
    // unreadable meter to 0, so a vendor-cloud gap would otherwise testify to
    // idleness on a device pulling full power. Staleness is judged on the
    // reading's OWN timestamp — device-wide `lastFreshDataMs` is a max across
    // capabilities, so a live thermometer would mask a silent power meter.
    let snapshot = createEmptyPowerCalibrationSnapshot();
    const staleBase = FIXED_NOW - 30 * 60_000;
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, {
        deviceId: 'hoiax-1',
        stepId: 'medium',
        measuredPowerKw: 1.6,
        nameplateKw: 1.75,
        nowMs: staleBase + i * 70_000,
      });
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    const ctx = ctxWithSnapshot(snapshot);
    const stale = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
      measuredPowerObservedAtMs: FIXED_NOW - 5 * 60_000,
    }));
    expect(stale.confirmedNotDrawing).toBe(false);
    const unmetered = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
      measuredPowerKw: undefined,
    }));
    expect(unmetered.confirmedNotDrawing).toBe(false);
  });

  it('is false when only the power meter went silent, however fresh the device is', () => {
    // Device-wide `lastFreshDataMs` is a max across capabilities, so a device
    // whose thermometer keeps reporting looks current while its power meter has
    // stopped. Judging freshness on that clock would let a stale cached zero
    // stand in for an unknown draw and cancel a configured or forced boost.
    let snapshot = createEmptyPowerCalibrationSnapshot();
    const staleBase = FIXED_NOW - 30 * 60_000;
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, {
        deviceId: 'hoiax-1',
        stepId: 'medium',
        measuredPowerKw: 1.6,
        nameplateKw: 1.75,
        nowMs: staleBase + i * 70_000,
      });
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
      // Fresh device, stale reading — the whole point.
      lastFreshDataMs: FIXED_NOW,
      measuredPowerObservedAtMs: FIXED_NOW - 5 * 60_000,
    }));
    expect(result.confirmedNotDrawing).toBe(false);
  });

  it('is false for a device PELS is holding off, whatever rung it still announces', () => {
    // A shed device is reporting the consequence of PELS's own shed, not a fact
    // about its demand — it must never testify itself out of the boost that
    // would resume it. `reportedStepId` keeps the rung the device announces
    // while the binary axis holds it off (an Easee reverts to 32 A and says so
    // while paused), so the off step's never-confident calibration does not
    // cover this on its own.
    let snapshot = createEmptyPowerCalibrationSnapshot();
    const staleBase = FIXED_NOW - 30 * 60_000;
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, {
        deviceId: 'hoiax-1',
        stepId: 'medium',
        measuredPowerKw: 1.6,
        nameplateKw: 1.75,
        nowMs: staleBase + i * 70_000,
      });
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
      binaryControl: { on: false },
    }));
    expect(result.confirmedNotDrawing).toBe(false);
  });

  it('exposes the recent-draw window constant for diagnostics', () => {
    expect(POWER_CALIBRATION_CONSTANTS.RECENT_DRAW_DEFAULT_MIN_KW).toBe(0.05);
  });
});
