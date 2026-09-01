/**
 * The identity of the meter the power tracker's current whole-home sample came
 * from, and the single rule for how long that identity stays usable.
 *
 * Lives in `lib/power` because the question is about the sample the TRACKER
 * currently serves and the lifetime of that sample — `MainMeterAuthority` is
 * its only caller, but the fact it holds is power's. It imports nothing but the
 * freshness constant its expiry is derived from.
 *
 * Split out of `MainMeterAuthority` because this is the one seam in that module
 * that owns state nothing else touches: it reads no settings, holds none of the
 * authority's edge-trigger log latches, and knows nothing about meter areas or
 * collisions. The authority asks it "which meter did we last sample?" and tells
 * it what each ADMITTED ingest resolved; every decision made from that answer
 * stays with the authority, next to the latches and the two side-effecting
 * reads it shares.
 */
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../../packages/shared-domain/src/powerFreshness';

/**
 * What this process can say about the provenance of the watts the power tracker
 * currently serves. Three states on purpose: a nullable device id would collapse
 * the last two, and the ownership fence must answer them in OPPOSITE directions.
 */
export type SampledMeterProvenance =
  /** An ingest admitted by THIS process proved the meter those watts came from. */
  | { state: 'proven'; deviceId: string }
  /**
   * The tracker still serves watts restored from persistence across a restart,
   * and nothing restored the identity that governed them. Not `unknown`: those
   * watts are real, still inside their decision-reaching lifetime, and may well
   * have come from a meter area's own meter.
   */
  | { state: 'unattributable' }
  /**
   * No provenance can reach a decision — nothing proven and no restored sample
   * still in reach, or an admitted sample that carried no id at all (which an
   * area meter never does; see `MainMeterAuthority.resolveSampled`).
   */
  | { state: 'unknown' };

export type SampledMeterIdentityDeps = {
  /**
   * The ingest stamp of the sample the power tracker currently serves, read
   * from the tracker's own state. Consulted ONLY until this process admits its
   * first identity-bearing ingest, so it always answers "what did the restart
   * hand us?" and never re-reads live watts this owner already has an identity
   * for. Omitted where no tracker exists (direct service tests): no restored
   * watts, hence no restart fence.
   */
  getRestoredSampleAtMs?: () => number | undefined;
};

/**
 * Is a sample stamped `sampleAtMs` still able to reach a control decision?
 *
 * Expiry is DERIVED, not tuned: the anchor is the tracker's stamp for the
 * sample, and `POWER_SAMPLE_STALE_SHED_TIMEOUT_MS` is when the silence policy
 * (`lib/power/meterSilence.ts`) blocks planning outright. Until that moment a
 * price, settings, or realtime rebuild plans Main against those carried-forward
 * watts AS MEASURED (the 60 s hold synthesis is gone — owner ruling
 * 2026-08-31), so an ownership fence built on their provenance must hold for
 * that whole window; past it, no build can spend them. The `Math.max(0, …)`
 * keeps a backwards clock jump on the fence's side of the boundary.
 */
const isWithinSampleLifetime = (nowMs: number, sampleAtMs: number): boolean => (
  Math.max(0, nowMs - sampleAtMs) < POWER_SAMPLE_STALE_SHED_TIMEOUT_MS
);

export class SampledMeterIdentity {
  /** Last proven identity; `null` until one is proven. */
  private deviceId: string | null = null;

  /**
   * The ingest timestamp of the sample that proved it — the SAME stamp the
   * power tracker recorded for those watts, because `note` is called from the
   * sample pipeline with the ingest's own `nowMs`. `null` until proven.
   */
  private sampleAtMs: number | null = null;

  /**
   * True until this process admits its first ingest. `loadPowerTracker`
   * restores the durable `lastPowerW`/`lastTimestamp` across a restart, but
   * nothing restores the identity that governed them — so between boot and the
   * first ingest the tracker can be serving an AREA meter's watts while this
   * owner looks empty. Reading that emptiness as "nothing was sampled" would
   * authorize Main against exactly the watts the fence exists to catch, so the
   * restored window resolves `unattributable` (fail closed) instead.
   */
  private awaitingFirstIngest = true;

  constructor(private readonly deps: SampledMeterIdentityDeps = {}) {}

  /**
   * The provenance of the watts the tracker currently serves, valid for exactly
   * the sample's own usable lifetime (see {@link isWithinSampleLifetime}).
   * Check-time expiry, so a total read blackout releases the fence at exactly
   * the moment it releases the sample — no report counting, no separate clock.
   */
  resolveFor(nowMs: number): SampledMeterProvenance {
    const proven = this.provenIdentityFor(nowMs);
    return proven === null
      ? this.restoredProvenanceFor(nowMs)
      : { state: 'proven', deviceId: proven };
  }

  private provenIdentityFor(nowMs: number): string | null {
    if (this.deviceId === null || this.sampleAtMs === null) return null;
    return isWithinSampleLifetime(nowMs, this.sampleAtMs) ? this.deviceId : null;
  }

  /**
   * Once an ingest has been admitted, the restored watts are gone from the
   * tracker and the live-sample rule owns the answer. Before that, the restored
   * sample fences for exactly as long as it could still drive a decision.
   */
  private restoredProvenanceFor(nowMs: number): SampledMeterProvenance {
    if (!this.awaitingFirstIngest) return { state: 'unknown' };
    const restoredAtMs = this.deps.getRestoredSampleAtMs?.();
    // Outer-layer value (persisted settings, reloaded by the tracker): a
    // missing or non-finite stamp is no evidence of served watts at all.
    if (typeof restoredAtMs !== 'number' || !Number.isFinite(restoredAtMs)) {
      return { state: 'unknown' };
    }
    return isWithinSampleLifetime(nowMs, restoredAtMs)
      ? { state: 'unattributable' }
      : { state: 'unknown' };
  }

  /**
   * Record what one ADMITTED sample ingest resolved. `sampleAtMs` is the
   * ingest's own timestamp — the identity and the watts share one clock by
   * construction. Every admitted Homey-Energy sample names its meter now (a
   * sample cannot exist without one), so the old id-less-retention rule is
   * gone with the id-less samples themselves.
   */
  note(deviceId: string, sampleAtMs: number): void {
    this.awaitingFirstIngest = false;
    this.deviceId = deviceId;
    this.sampleAtMs = sampleAtMs;
  }

  /**
   * A Flow-card sample replaced the tracker watts. Flow has no meter identity
   * to retain, and the previous Homey-Energy identity no longer describes the
   * current sample, so clear it rather than applying the live id-less
   * Homey-Energy retention rule from {@link note}.
   */
  noteFlowReplacement(): void {
    this.awaitingFirstIngest = false;
    this.deviceId = null;
    this.sampleAtMs = null;
  }
}
