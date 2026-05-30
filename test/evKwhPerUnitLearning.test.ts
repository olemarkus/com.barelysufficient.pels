import {
  OBJECTIVE_PROFILE_MIN_INTERVAL_MS,
  updateObjectiveProfilesFromSnapshot,
} from '../lib/objectives/profiles';
import { resolveProfileEnergy } from '../lib/objectives/deferredObjectives/profileEnergyResolution';
import { BOOTSTRAP_EV_SOC_KWH_PER_PERCENT } from '../packages/shared-domain/src/objectiveProfileBootstrap';
import type { PowerTrackerState } from '../lib/power/tracker';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

// EV kWhPerUnit learning end-to-end: snapshot ingest → profile sample acceptance/
// rejection → resolveProfileEnergy switching between bootstrap and learned. The
// existing `objectiveProfiles.test.ts` covers a single accepted-rise case; this
// suite focuses on the bootstrap↔learned cutover and the EV-specific rejection
// reason codes.

const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const hourMs = 60 * 60 * 1000;

// `MIN_SOC_RISE_PERCENT` in `lib/objectives/profiles.ts` (0.2 %) — the minimum
// SoC delta that counts as a learnable rise. Anything strictly smaller and
// non-negative produces `objective_profile_rise_too_small`. Kept here as a
// local mirror so a future production change to the threshold trips the
// rise-below-threshold assertion (which uses `MIN_SOC_RISE_PERCENT - 0.1`).
const MIN_SOC_RISE_PERCENT = 0.2;

const evDevice = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'ev-1',
  name: 'Charger',
  targets: [],
  deviceClass: 'evcharger',
  currentOn: true,
  measuredPowerKw: 7,
  stateOfCharge: {
    percent: 40,
    status: 'fresh',
    observedAtMs: startMs,
  },
  ...overrides,
});

const ingestEvSample = (params: {
  state: PowerTrackerState;
  percent: number;
  atMs: number;
  measuredPowerKw?: number;
  deviceId?: string;
  debugStructured?: (payload: Record<string, unknown>) => void;
}): PowerTrackerState => {
  const { state, percent, atMs, measuredPowerKw, deviceId, debugStructured } = params;
  return updateObjectiveProfilesFromSnapshot({
    state,
    devices: [
      evDevice({
        ...(deviceId ? { id: deviceId } : {}),
        ...(measuredPowerKw !== undefined ? { measuredPowerKw } : {}),
        stateOfCharge: {
          percent,
          status: 'fresh',
          observedAtMs: atMs,
        },
      }),
    ],
    nowMs: atMs,
    debugStructured,
  });
};

const resolveEv = (params: {
  state: PowerTrackerState;
  remainingUnits: number;
  currentValue?: number;
  deviceId?: string;
}) => resolveProfileEnergy({
  powerTracker: params.state,
  deviceId: params.deviceId ?? 'ev-1',
  objectiveKind: 'ev_soc',
  enforcement: 'hard',
  remainingUnits: params.remainingUnits,
  currentValue: params.currentValue,
});

describe('EV kWhPerUnit learning', () => {
  // The rejection-log throttle (`lib/objectives/rejectionLogging.ts`) keys
  // routine reasons (`rise_too_small`, `value_fell`) by reason across *all*
  // devices and remembers the last emission for 15 min of wall-clock. Advance
  // a process-lifetime counter past that window per test so each rejection
  // case actually emits its structured-debug payload regardless of run order.
  const REJECTION_THROTTLE_STRIDE_MS = 30 * 60 * 1000;
  let fakeNowMs = Date.UTC(2027, 0, 1, 0, 0, 0);

  beforeEach(() => {
    fakeNowMs += REJECTION_THROTTLE_STRIDE_MS;
    vi.useFakeTimers();
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('bootstrap path', () => {
    it('uses BOOTSTRAP_EV_SOC_KWH_PER_PERCENT when no profile has been learned yet', () => {
      const result = resolveEv({
        state: {},
        remainingUnits: 20,
        currentValue: 40,
      });

      expect(result.reasonCode).toBeNull();
      if (result.reasonCode !== null) return;
      expect(result.kwhPerUnitSource).toBe('bootstrap');
      expect(result.kWhPerUnit).toBe(BOOTSTRAP_EV_SOC_KWH_PER_PERCENT);
      // Bootstrap planning energy is `remainingUnits * BOOTSTRAP_EV_SOC_KWH_PER_PERCENT`
      // with planned == expected (no learned σ yet, the bootstrap constant is
      // already conservative-high).
      expect(result.energyNeededKWh).toBeCloseTo(20 * BOOTSTRAP_EV_SOC_KWH_PER_PERCENT, 6);
      expect(result.energyExpectedKWh).toBeCloseTo(20 * BOOTSTRAP_EV_SOC_KWH_PER_PERCENT, 6);
    });
  });

  describe('accepted SoC rise', () => {
    it('records a kWhPerUnit sample equal to delivered energy / SoC delta', () => {
      // 7 kW for 1 h delivers 7 kWh into a 10 % SoC rise → 0.7 kWh per percent.
      let state: PowerTrackerState = ingestEvSample({
        state: {}, percent: 40, atMs: startMs,
      });
      state = ingestEvSample({
        state, percent: 50, atMs: startMs + hourMs,
      });

      const profile = state.objectiveProfiles?.['ev-1'];
      expect(profile?.kind).toBe('ev_soc');
      expect(profile?.acceptedSamples).toBe(1);
      expect(profile?.kwhPerUnit?.sampleCount).toBe(1);
      expect(profile?.kwhPerUnit?.mean).toBeCloseTo(0.7, 6);
      // `lastSample.value` advances to the post-rise SoC so the next accepted
      // rise integrates against the new baseline.
      expect(profile?.lastSample.value).toBe(50);
    });
  });

  describe('bootstrap → learned cutover', () => {
    it('switches `resolveProfileEnergy` from bootstrap to learned after the first accepted sample', () => {
      // Cold-start: no profile yet → bootstrap path returns the canonical
      // constant.
      const beforeLearning = resolveEv({
        state: {},
        remainingUnits: 10,
        currentValue: 40,
      });
      expect(beforeLearning.reasonCode).toBeNull();
      if (beforeLearning.reasonCode !== null) return;
      expect(beforeLearning.kwhPerUnitSource).toBe('bootstrap');
      expect(beforeLearning.kWhPerUnit).toBe(BOOTSTRAP_EV_SOC_KWH_PER_PERCENT);

      // One accepted rise records a 0.7 kWh/% sample (7 kW × 1 h / 10 %).
      let state: PowerTrackerState = ingestEvSample({
        state: {}, percent: 40, atMs: startMs,
      });
      state = ingestEvSample({
        state, percent: 50, atMs: startMs + hourMs,
      });

      const afterLearning = resolveEv({
        state,
        remainingUnits: 10,
        currentValue: 50,
      });
      expect(afterLearning.reasonCode).toBeNull();
      if (afterLearning.reasonCode !== null) return;
      expect(afterLearning.kwhPerUnitSource).toBe('learned');
      // Single-sample mean is exact; the planner now uses learned 0.7 kWh/%
      // instead of bootstrap 1.0 kWh/%.
      expect(afterLearning.kWhPerUnit).toBeCloseTo(0.7, 6);
      expect(afterLearning.kWhPerUnit).not.toBe(BOOTSTRAP_EV_SOC_KWH_PER_PERCENT);
      // Booked energy follows the learned rate: 10 % × 0.7 kWh/% = 7 kWh,
      // versus bootstrap 10 % × 1.0 kWh/% = 10 kWh.
      expect(afterLearning.energyExpectedKWh).toBeCloseTo(7, 6);
    });
  });

  describe('rejection reasons', () => {
    it('rejects a no-progress SoC sample with `rise_too_small` (zero delta, non-negative)', () => {
      // Baseline 40 % at startMs; second sample at startMs + 1h still reads
      // 40 % despite credible charging power. Zero delta is `>= 0` and below
      // MIN_SOC_RISE_PERCENT (0.2 %), so it's `rise_too_small` rather than
      // `value_fell`.
      const debugStructured = vi.fn();
      let state: PowerTrackerState = ingestEvSample({
        state: {}, percent: 40, atMs: startMs, deviceId: 'ev-noprogress',
      });
      state = ingestEvSample({
        state,
        percent: 40,
        atMs: startMs + hourMs,
        deviceId: 'ev-noprogress',
        debugStructured,
      });

      const profile = state.objectiveProfiles?.['ev-noprogress'];
      expect(profile?.acceptedSamples).toBe(0);
      expect(profile?.rejectedSamples).toBe(1);
      expect(profile?.kwhPerUnit).toBeUndefined();
      expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
        event: 'objective_profile_sample_rejected',
        reasonCode: 'objective_profile_rise_too_small',
      }));
    });

    it('rejects a duplicate-timestamp SoC sample with `non_monotonic_time`', () => {
      // Baseline 40 % at startMs; second sample carries the same observedAtMs
      // but a different (would-be accepted) value. The timing guard runs
      // before the value-delta check, so this trips `non_monotonic_time`.
      const debugStructured = vi.fn();
      let state: PowerTrackerState = ingestEvSample({
        state: {}, percent: 40, atMs: startMs, deviceId: 'ev-duplicate',
      });
      state = ingestEvSample({
        state,
        percent: 50,
        atMs: startMs,
        deviceId: 'ev-duplicate',
        debugStructured,
      });

      const profile = state.objectiveProfiles?.['ev-duplicate'];
      expect(profile?.acceptedSamples).toBe(0);
      expect(profile?.rejectedSamples).toBe(1);
      expect(profile?.kwhPerUnit).toBeUndefined();
      expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
        event: 'objective_profile_sample_rejected',
        reasonCode: 'objective_profile_non_monotonic_time',
      }));
    });

    it('rejects an SoC rise below MIN_SOC_RISE_PERCENT with `rise_too_small`', () => {
      // Baseline 40 % at startMs; rise of 0.1 % (strictly below the 0.2 %
      // MIN_SOC_RISE_PERCENT threshold, intervalMs above the
      // OBJECTIVE_PROFILE_MIN_INTERVAL_MS guard so the value-delta check is
      // the one that fires).
      const debugStructured = vi.fn();
      const tooSmallRise = MIN_SOC_RISE_PERCENT - 0.1;
      const intervalMs = OBJECTIVE_PROFILE_MIN_INTERVAL_MS + 60_000;

      let state: PowerTrackerState = ingestEvSample({
        state: {}, percent: 40, atMs: startMs, deviceId: 'ev-toosmall',
      });
      state = ingestEvSample({
        state,
        percent: 40 + tooSmallRise,
        atMs: startMs + intervalMs,
        deviceId: 'ev-toosmall',
        debugStructured,
      });

      const profile = state.objectiveProfiles?.['ev-toosmall'];
      expect(profile?.acceptedSamples).toBe(0);
      expect(profile?.rejectedSamples).toBe(1);
      expect(profile?.kwhPerUnit).toBeUndefined();
      expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
        event: 'objective_profile_sample_rejected',
        reasonCode: 'objective_profile_rise_too_small',
      }));
    });
  });
});
