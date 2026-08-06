import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../../packages/shared-domain/src/powerFreshness';

/**
 * Freshness producer for the observer's held generation reading: resolves it
 * into a value a power sample may carry, or `undefined` when there is nothing
 * trustworthy to co-sample.
 *
 * Lives in `lib/observer/` beside `observationFreshness.ts` because freshness is
 * this layer's mandate — consumers read a producer-resolved answer and must not
 * re-derive it from a raw age (`lib/observer/AGENTS.md`). `ObservedHomePower`
 * itself stays a dumb value+time store; the POLICY is here.
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
 * an integral. `accrueSolarSample` integrates the held reading across the whole
 * interval between samples, so a stale-inherited value does not merely mislabel
 * one sample; it writes kWh-scale error into `generationBuckets`, which is what
 * the Solar card shows and the money lines price.
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
