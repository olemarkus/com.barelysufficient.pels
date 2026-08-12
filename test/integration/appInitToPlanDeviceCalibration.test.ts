/**
 * Coverage for `toPlanDevice`'s calibration-view enrichment.
 *
 * Verifies the boost-gate semantic contract:
 *   - When the device has no `reportedStepId`, `hasRecentObservedDraw`
 *     is `undefined` even if `selectedStepId` matches a calibration entry —
 *     the gate treats `undefined` as "no opinion, keep the legacy bypass."
 *   - A recent in-band draw at ANY step yields `true`, regardless of which
 *     step is currently reported — a just-stepped-up device still ramping at
 *     the previous step's level is accepting load, not idle.
 *   - A concrete `false` requires the reported step to be calibration-
 *     confident with every step quiet (the idle-at-setpoint signature).
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

const buildDeviceSnapshot = (overrides: Partial<DecoratedDeviceSnapshot> = {}): DecoratedDeviceSnapshot => ({
  id: 'hoiax-1',
  name: 'Hoiax',
  targets: [],
  controlModel: 'stepped_load',
  steppedLoadProfile: HOIAX_PROFILE,
  binaryControl: { on: true },
  ...overrides,
}) as DecoratedDeviceSnapshot;

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

describe('toPlanDevice — hasRecentObservedDraw', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns undefined when the device has no reportedStepId, even if selectedStepId has a calibration entry', () => {
    const snapshot = buildSnapshotWithMediumEntry();
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      selectedStepId: 'medium',
      // No reportedStepId → no observational truth about which step the
      // device is currently at. The resolver must NOT fall back to the
      // planner's intended step.
    }));
    expect(result.hasRecentObservedDraw).toBeUndefined();
  });

  it('returns true when reportedStepId matches a confident calibration entry inside the recent-draw window', () => {
    const snapshot = buildSnapshotWithMediumEntry();
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
    }));
    expect(result.hasRecentObservedDraw).toBe(true);
  });

  it('returns true when another step has recent draw, even though the reported step has no entry', () => {
    // The staircase case from prod (2026-07-05): right after a step change
    // the newly reported step has no accepted samples yet (ramp readings are
    // skipped as out-of-band) while the step it came from still holds fresh
    // in-band samples. The device is demonstrably accepting load; the gate
    // must not read this as idle.
    const snapshot = buildSnapshotWithMediumEntry();
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'low',
      selectedStepId: 'low',
    }));
    expect(result.hasRecentObservedDraw).toBe(true);
  });

  it('returns true for a recent warm-up sample (below confidence, but real draw)', () => {
    // A single accepted sample is below the confidence threshold, but it is
    // still a recent in-band observation — evidence of draw, never a
    // concrete `false` that would suppress boost swaps for newly paired
    // devices.
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
    expect(result.hasRecentObservedDraw).toBe(true);
  });

  it('returns false when the reported step is confident and every step is quiet', () => {
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
    expect(result.hasRecentObservedDraw).toBe(false);
  });

  it('exposes the recent-draw window constant for diagnostics', () => {
    expect(POWER_CALIBRATION_CONSTANTS.RECENT_DRAW_DEFAULT_MIN_KW).toBe(0.05);
  });
});
