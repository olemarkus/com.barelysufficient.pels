import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';
import type { GenerationReading } from './observedHomePower';

/**
 * Freshness producer for the observer's held generation reading: resolves it
 * into a value a power sample may carry, or `undefined` when there is nothing
 * trustworthy to co-sample.
 *
 * Lives in `lib/observer/` because freshness policy is this layer's mandate —
 * consumers read a producer-resolved answer and must not re-derive it from a raw
 * age (`lib/observer/AGENTS.md`). `ObservedHomePower` itself stays a dumb
 * value+time store; the POLICY is here.
 *
 * This is about the whole-home METER, which pushes on a fixed cadence and whose
 * silence therefore IS a fault. It is not a per-device observation, where
 * silence means "unchanged" and no timeout applies.
 *
 * Needed only where net and production arrive on DIFFERENT clocks — the flow
 * source, where net comes from the `report_power_usage` card and production from
 * the companion poll (`GenerationPollSource`). On `homey_energy` the two are read
 * from one report and travel together on the sample itself, so nothing calls
 * this.
 *
 * The window is the existing `POWER_SAMPLE_STALE_THRESHOLD_MS` (60 s) rather
 * than a second freshness concept: the companion poll runs on the same 10 s
 * cadence as the Homey Energy poll, so a reading older than a minute means the
 * poll stopped, not that production is steady. Past it the sample carries no
 * generation — the pre-existing behaviour — never a stale value inherited into
 * the PV forecast trainer and the gross-consumption split it feeds. The
 * `generationBuckets` accrual does not take this value at all: it integrates
 * {@link resolveGenerationSegments}, the readings on their own clock, because
 * one reading held across a sparse Flow interval writes kWh-scale error into
 * what the Solar card shows and the money lines price.
 *
 * Absence of a VALUE and absence of a TIMESTAMP are different: a reading of
 * `null` (the report carried no generation) is a real observation meaning "this
 * home is producing nothing right now", but it is still expressed as `undefined`
 * here because the sample's contract is "generation known" vs "not known", and a
 * home with no PV must not start writing zero-generation samples.
 */
export const resolveFreshGenerationW = (params: {
  generationW: number | null;
  observedAtMs: number | null;
  nowMs: number;
}): number | undefined => {
  const { generationW, observedAtMs, nowMs } = params;
  if (generationW === null || observedAtMs === null) return undefined;
  if (!Number.isFinite(generationW) || !Number.isFinite(observedAtMs)) return undefined;
  // Production is `+`-only at every producer, so a negative reading is malformed
  // rather than "exporting". Reject it here, at the resolution point, so no
  // consumer has to floor it — a floor would fabricate a zero-production
  // observation out of junk and accrue it as fact.
  if (generationW < 0) return undefined;
  const ageMs = nowMs - observedAtMs;
  // A future-dated reading is as untrustworthy as an expired one (clock change,
  // restart); treat it as absent rather than reasoning about it.
  if (ageMs < 0 || ageMs >= POWER_SAMPLE_STALE_THRESHOLD_MS) return undefined;
  return generationW;
};

/**
 * One stretch of constant production, in watts, that a reading vouches for.
 * The tracker integrates these straight into its generation buckets.
 */
export type GenerationSegment = {
  readonly startMs: number;
  readonly endMs: number;
  readonly watts: number;
};

/**
 * Resolves the reading history into the stretches of production it actually
 * observed, up to `nowMs` — the tracker's only input for generation kWh, on
 * every source, so production accrues on the readings' own clock rather than
 * the net sample's. On `homey_energy` the readings come from the same 10 s
 * reports as the samples; on `flow` from the companion poll.
 *
 * Why this exists: a Flow-reported net sample can be 30 minutes from the next
 * one. Holding the one generation reading taken beside a sample across that
 * whole interval mints kWh the panels never produced (7 kW at 12:00, collapsed
 * at 12:01, next report at 12:30: ~3.5 kWh of ghost production). The companion
 * poll kept reading every 10 s all along; these segments are those readings.
 *
 * Each reading holds until the next reading, and never past the same freshness
 * window {@link resolveFreshGenerationW} applies: if the poll stops, the last
 * reading vouches for one minute of production, not for the rest of the gap.
 * A `null` reading ("no generator") and a zero reading produce no segment, so
 * night hours stay sparse, but both still end the reading before them. A
 * negative or non-finite reading is malformed and likewise produces nothing.
 * Readings stamped after `nowMs` are not yet part of this interval.
 */
export const resolveGenerationSegments = (
  readings: readonly GenerationReading[],
  nowMs: number,
): GenerationSegment[] => {
  const past = readings.filter((reading) => reading.observedAtMs < nowMs);
  return past.flatMap(({ watts, observedAtMs }, index): GenerationSegment[] => {
    if (watts === null || !Number.isFinite(watts) || watts <= 0) return [];
    const nextObservedAtMs = past[index + 1]?.observedAtMs ?? Number.POSITIVE_INFINITY;
    const endMs = Math.min(nextObservedAtMs, observedAtMs + POWER_SAMPLE_STALE_THRESHOLD_MS, nowMs);
    return endMs > observedAtMs ? [{ startMs: observedAtMs, endMs, watts }] : [];
  });
};
