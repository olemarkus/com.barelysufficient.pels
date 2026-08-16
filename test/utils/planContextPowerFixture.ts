import type { PlanContext } from '../../lib/plan/planContext';
import {
  PowerFreshnessMonitor,
  type PowerCycleReading,
} from '../../lib/power/powerCycleReading';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../lib/power/sampleFreshness';

const FIXTURE_NOW_MS = Date.UTC(2026, 3, 18, 10, 0, 0);
const FRESH_SAMPLE_AGE_MS = 1_000;

export type PlanContextPowerMembers = Pick<
  PlanContext,
  'headroomForLimitKw' | 'powerIsMeasured' | 'powerMeasuredAtOrBelowKw'
  | 'powerMeasuredAboveKw' | 'measuredDrawKw'
>;

/**
 * The power members of a `PlanContext`, resolved by the REAL producer.
 *
 * Fixtures used to set `total` / `planningTotalKw` / `powerFreshnessState`
 * directly, which let a test describe a home no producer can produce (a total
 * with no sample, a `fresh` label with no reading). Since the planner receives
 * answers rather than ingredients, a fixture states the one thing that is
 * actually true — what the meter read, or that it read nothing — and
 * `PowerFreshnessMonitor` derives the answers exactly as production does.
 *
 * Driving the real monitor rather than restating its rule is the point: a change
 * to the forcing or to what counts as measured cannot leave the suite green
 * against a stale copy of the old behaviour.
 */
export const planContextPowerReading = (
  totalKw: number | null,
  options: { measured?: boolean; failClosed?: boolean } = {},
): PowerCycleReading => {
  const measured = options.measured ?? (typeof totalKw === 'number' && Number.isFinite(totalKw));
  // Age drives the producer's answer, so the fixture's intent is expressed as an
  // age rather than as a state name it would otherwise have to keep in sync.
  // Unmeasured defaults to the HOLD window (synthesized 0), not fail-closed:
  // holding is the ordinary unmeasured cycle, and -1 is the escalation a fixture
  // has to ask for.
  const unmeasuredAgeMs = options.failClosed === true
    ? POWER_SAMPLE_STALE_SHED_TIMEOUT_MS
    : POWER_SAMPLE_STALE_THRESHOLD_MS;
  const ageMs = measured && options.failClosed !== true ? FRESH_SAMPLE_AGE_MS : unmeasuredAgeMs;
  return new PowerFreshnessMonitor().observe({
    powerTracker: { lastTimestamp: FIXTURE_NOW_MS - ageMs },
    totalKw,
    nowMs: FIXTURE_NOW_MS,
  });
};

export const planContextPower = (
  totalKw: number | null,
  options: { measured?: boolean; failClosed?: boolean } = {},
): PlanContextPowerMembers => {
  const reading = planContextPowerReading(totalKw, options);
  return {
    headroomForLimitKw: reading.headroomKw,
    powerIsMeasured: reading.isMeasured,
    powerMeasuredAtOrBelowKw: reading.measuredAtOrBelowKw,
    powerMeasuredAboveKw: reading.measuredAboveKw,
    measuredDrawKw: reading.display.measuredTotalKw,
  };
};
