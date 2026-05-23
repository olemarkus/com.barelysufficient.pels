/**
 * Coverage for `toPlanDevice`'s calibration-view enrichment.
 *
 * Verifies the boost-gate semantic contract:
 *   - When the device has no `reportedStepId`, `hasRecentObservedDrawAtSelectedStep`
 *     is `undefined` even if `selectedStepId` matches a calibration entry —
 *     the gate treats `undefined` as "no opinion, keep the legacy bypass."
 *   - When the device has a `reportedStepId` that matches a calibration entry,
 *     the field reflects the calibration store's `hasRecentDrawAt` answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toPlanDevice } from '../lib/app/appInit';
import {
  createEmptyPowerCalibrationSnapshot,
  POWER_CALIBRATION_CONSTANTS,
  recordSample,
} from '../lib/observer/devicePowerCalibration';
import type { PowerCalibrationSnapshot } from '../packages/contracts/src/powerCalibration';
import { createAppContextMock } from './helpers/appContextTestHelpers';
import type { AppContext } from '../lib/app/appContext';
import type { SteppedLoadProfile, TargetDeviceSnapshot } from '../packages/contracts/src/types';

const HOIAX_PROFILE: SteppedLoadProfile = {
  model: 'stepped_load',
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

const buildDeviceSnapshot = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'hoiax-1',
  name: 'Hoiax',
  targets: [],
  controlModel: 'stepped_load',
  steppedLoadProfile: HOIAX_PROFILE,
  currentOn: true,
  ...overrides,
}) as TargetDeviceSnapshot;

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

describe('toPlanDevice — hasRecentObservedDrawAtSelectedStep', () => {
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
    expect(result.hasRecentObservedDrawAtSelectedStep).toBeUndefined();
  });

  it('returns true when reportedStepId matches a confident calibration entry inside the recent-draw window', () => {
    const snapshot = buildSnapshotWithMediumEntry();
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'medium',
      selectedStepId: 'medium',
    }));
    expect(result.hasRecentObservedDrawAtSelectedStep).toBe(true);
  });

  it('returns undefined when reportedStepId points at an unknown calibration step', () => {
    const snapshot = buildSnapshotWithMediumEntry();
    const ctx = ctxWithSnapshot(snapshot);
    const result = toPlanDevice(ctx, buildDeviceSnapshot({
      reportedStepId: 'low',
      selectedStepId: 'low',
    }));
    // No calibration entry for 'low' → undefined (no opinion).
    expect(result.hasRecentObservedDrawAtSelectedStep).toBeUndefined();
  });

  it('returns undefined for an existing-but-non-confident step (warm-up)', () => {
    // A single sample is below the 5-sample / 5-minute confidence threshold.
    // The gate must report `undefined` rather than letting a warm-up entry
    // produce a concrete `false` that suppresses boost escalation for newly
    // paired devices.
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
    expect(result.hasRecentObservedDrawAtSelectedStep).toBeUndefined();
  });

  it('exposes the recent-draw window constant for diagnostics', () => {
    expect(POWER_CALIBRATION_CONSTANTS.RECENT_DRAW_DEFAULT_MIN_KW).toBe(0.05);
  });
});
