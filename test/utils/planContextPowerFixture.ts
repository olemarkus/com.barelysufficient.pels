import type { PlanContext } from '../../lib/plan/planContext';
import {
  resolvePowerCycleReading,
  type PowerCycleReading,
} from '../../lib/power/powerCycleReading';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../../lib/power/sampleFreshness';

const FIXTURE_NOW_MS = Date.UTC(2026, 3, 18, 10, 0, 0);
const FRESH_SAMPLE_AGE_MS = 1_000;

export type PlanContextPowerMembers = Pick<
  PlanContext,
  'headroomForLimitKw' | 'powerIsMeasured' | 'powerMeasuredAtOrBelowKw'
  | 'powerMeasuredAboveKw' | 'drawKw'
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
  totalKw: number,
  options: { failClosed?: boolean } = {},
): PowerCycleReading => {
  // Age drives the producer's answer, so the fixture's intent is expressed as
  // production state rather than a label it would have to keep in sync.
  // `failClosed` is the escalation's one silent-window pass (age past the shed
  // timeout, synthesized -1). A reading always exists — the gate guarantees it
  // in production and the fixture states it as tracker state, exactly as
  // ingest would have latched it.
  const ageMs = options.failClosed === true ? POWER_SAMPLE_STALE_SHED_TIMEOUT_MS : FRESH_SAMPLE_AGE_MS;
  return resolvePowerCycleReading({
    powerTracker: { lastPowerW: totalKw * 1000, lastTimestamp: FIXTURE_NOW_MS - ageMs },
    nowMs: FIXTURE_NOW_MS,
  });
};

export const planContextPower = (
  totalKw: number,
  options: { failClosed?: boolean } = {},
): PlanContextPowerMembers => {
  const reading = planContextPowerReading(totalKw, options);
  return {
    headroomForLimitKw: reading.headroomKw,
    powerIsMeasured: reading.isMeasured,
    powerMeasuredAtOrBelowKw: reading.measuredAtOrBelowKw,
    powerMeasuredAboveKw: reading.measuredAboveKw,
    drawKw: reading.display.totalKw,
  };
};
