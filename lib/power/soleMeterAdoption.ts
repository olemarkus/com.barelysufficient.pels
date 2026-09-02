import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import type { TimerRegistry } from '../utils/timerRegistry';

const adoptionLogger = getLogger('power/sole-meter-adoption');

const TIMER_NAME = 'soleMeterAdoption';
/**
 * Two reads this far apart must name the same sole meter before anything is
 * written. Right after a Homey reboot the live report can show one meter
 * while a slower app's meter has not published yet; the registry cross-check
 * in the census catches a meter that exists but is silent, and the second
 * read catches one that appears in between.
 */
const ATTEMPT_INTERVAL_MS = 30_000;
/** ~5 minutes per boot. A meter that is not there by then is found on the next boot. */
const MAX_ATTEMPTS = 10;
/**
 * A LISTED meter key answering `null` is either the legacy stored-null
 * Automatic selection or a transient miss of an explicitly stored id, and the
 * value alone cannot tell them apart. The bounded grace: the null must be
 * read on this many consecutive attempts (`ATTEMPT_INTERVAL_MS` apart, with
 * the key list answering each time) before it counts as "nothing chosen".
 */
const LISTED_NULL_GRACE_READS = 3;

/**
 * Whether this install is one the adoption may name a meter for: nothing
 * chosen (adoptable), settled by the owner, or a read that must not be
 * trusted this attempt. Resolved by the settings adapter that owns the raw
 * reads (`setup/soleMeterAdoption.ts`); this component branches on the flat
 * states only.
 */
export type SoleMeterAdoptionEligibility =
  | {
    kind: 'eligible';
    detail: 'unset_source' | 'no_meter_chosen';
    /** Whether the meter key was never written, or is listed and answered `null`. */
    meterKey: 'unwritten' | 'listed_null';
  }
  /**
   * An explicit meter with no source: the seam writes the meter first and the
   * source second, so this is a Power meter save that died in between. The
   * meter is the owner's; only the source half is missing, and completing it
   * needs no census and no readings gate.
   */
  | { kind: 'complete'; meterDeviceId: string }
  | { kind: 'settled'; detail: 'flow_source' | 'explicit_meter' }
  | { kind: 'defer'; reasonCode: 'empty_key_list' | 'missing_existing_key' | 'suspect_meter_value' | 'read_failed' };

/**
 * The sole-cumulative-meter census over the live report, cross-checked
 * against the device registry — the semantic state the device transport
 * resolves raw Homey payloads into (`lib/device/soleCumulativeMeter.ts`),
 * and the one this component branches on.
 */
export type SoleCumulativeMeterResolution =
  | { state: 'resolved'; meterDeviceId: string }
  | { state: 'unresolvable'; reason: 'none_found' | 'ambiguous' | 'idless_sole' | 'registry_mismatch' };

/** The census as the transport adapter resolves it: the resolution, or a fetch that failed. */
export type SoleMeterAdoptionCensus =
  | SoleCumulativeMeterResolution
  | { readonly state: 'unavailable' };

/** What the persisted write answered, resolved by the seam that owns the two keys. */
export type SoleMeterAdoptionWriteOutcome =
  | { result: 'adopted' }
  | { result: 'retry'; reasonCode: string }
  | { result: 'not_applicable'; reasonCode: string };

export type SoleMeterAdoptionDeps = {
  classifyEligibility: () => SoleMeterAdoptionEligibility;
  census: () => Promise<SoleMeterAdoptionCensus>;
  adopt: (meterDeviceId: string) => SoleMeterAdoptionWriteOutcome;
  /**
   * Whether the power tracker admitted a whole-home sample at or after the
   * given time. Readings that ever arrived on an install that never wrote the
   * source key came through a Flow the owner built, and Flows fire on their
   * own cadence, hours apart if they like; that arrangement is the owner's,
   * not something to adopt over. `unknown` is a tracker whose persisted
   * history could not be read this boot: a transient, so this attempt
   * decides nothing.
   */
  readingsAdmittedSince: (sinceMs: number) => 'admitted' | 'none' | 'unknown';
  timers: TimerRegistry;
  now: () => number;
};

const isListedNull = (eligibility: SoleMeterAdoptionEligibility): boolean => (
  eligibility.kind === 'eligible' && eligibility.meterKey === 'listed_null'
);

/** What one attempt found. The write itself happens only behind the teardown fence. */
type AttemptResult =
  | { result: 'confirm'; meterDeviceId: string }
  /** Finish a half-applied Power meter save with the meter it already stored. */
  | { result: 'complete'; meterDeviceId: string }
  | { result: 'settled'; detail: 'flow_source' | 'explicit_meter' }
  | { result: 'not_applicable'; reasonCode: string }
  | { result: 'propose'; meterDeviceId: string }
  /** Agreeing reads, held for the listed-null grace: the pending meter is kept. */
  | { result: 'hold'; meterDeviceId: string }
  /**
   * Nothing decided this attempt. `transient` is a read that failed (a fetch,
   * a settings miss, a registry that could not corroborate): a no-op, and the
   * pending meter survives it. Otherwise the census answered and did not
   * name the pending meter, which restarts the confirmation.
   */
  | { result: 'retry'; reasonCode: string; transient: boolean };

/**
 * Once per boot: if the owner has not chosen a source (or chose the Power
 * meter source and never picked a meter) and Homey lists exactly one
 * id-bearing whole-home meter — in the live report and in the device
 * registry — persist that meter and the Power meter source, the same write
 * the owner's pick would make.
 *
 * Bounded on purpose. No marker: the condition clears itself once a meter is
 * stored, and an owner who pairs a meter later gets it on the next boot
 * instead of never. Never writes Flow: Flow is the owner's choice or the
 * unset default the runtime already resolves. Reads no persisted key beyond
 * the two the seam writes (its predecessor keyed "fresh install" on
 * `power_tracker_state` and lost to the tracker's first prune on every boot);
 * whether readings ever arrived is the tracker's own classified answer, and
 * a suspect answer decides nothing. A
 * write needs two consecutive reads `ATTEMPT_INTERVAL_MS` apart naming the
 * same sole meter (three, when the meter key is listed and answers `null`:
 * `LISTED_NULL_GRACE_READS`); several meters or an id-less aggregate end the boot's run
 * with nothing written, and a warming-up report retries up to `MAX_ATTEMPTS`.
 * The write happens only behind the teardown fence.
 */
export class SoleMeterAdoption {
  private attempt = 0;
  private pendingMeterDeviceId: string | null = null;
  private listedNullReads = 0;
  private startedAtMs = 0;
  private eligibleDetail: 'unset_source' | 'no_meter_chosen' | 'source_missing' | 'deferred' = 'deferred';
  /**
   * Whether a reading EVER arrived, read once at start: the tracker's first
   * prune persists the in-memory state 10 s after boot, and after a suspect
   * boot load that state is blank, so a later read would see a clean "never"
   * where there was history. Read before the prune can fire, kept for the run.
   */
  private historyAtStart: 'admitted' | 'none' | 'unknown' = 'unknown';

  constructor(private readonly deps: SoleMeterAdoptionDeps) {}

  start(): void {
    const eligibility = this.deps.classifyEligibility();
    if (eligibility.kind === 'settled') return;
    this.startedAtMs = this.deps.now();
    this.historyAtStart = this.deps.readingsAdmittedSince(Number.NEGATIVE_INFINITY);
    // A deferred first read is a transient miss, not an answer: every attempt
    // re-classifies before deciding anything, so the ladder still runs.
    if (eligibility.kind === 'eligible') {
      this.eligibleDetail = eligibility.detail;
      adoptionLogger.info({ event: 'sole_meter_adoption_started', detail: eligibility.detail });
    } else if (eligibility.kind === 'complete') {
      this.eligibleDetail = 'source_missing';
      adoptionLogger.info({ event: 'sole_meter_adoption_started', detail: 'source_missing' });
    } else {
      adoptionLogger.info({ event: 'sole_meter_adoption_started', deferredReasonCode: eligibility.reasonCode });
    }
    this.schedule();
  }

  private finish(): void {
    this.deps.timers.clear(TIMER_NAME);
  }

  private schedule(): void {
    this.attempt += 1;
    this.deps.timers.registerTimeout(TIMER_NAME, setTimeout(() => {
      this.runAttempt();
    }, ATTEMPT_INTERVAL_MS));
  }

  private scheduleOrGiveUp(reasonCode: string): void {
    if (this.attempt >= MAX_ATTEMPTS) {
      adoptionLogger.info({ event: 'sole_meter_adoption_gave_up_this_boot', reasonCode, attempts: this.attempt });
      this.finish();
      return;
    }
    this.schedule();
  }

  private concludeNotApplicable(reasonCode: string): void {
    adoptionLogger.info({ event: 'sole_meter_adoption_not_applicable', reasonCode });
    this.finish();
  }

  private runAttempt(): void {
    this.attemptOnce()
      .then((step) => {
        // Teardown fence: `onUninit` clears every registered timer, and this
        // entry stays registered for the whole attempt, so a census that
        // resolves after teardown decides nothing — and writes nothing, since
        // the write lives behind this check.
        if (!this.deps.timers.has(TIMER_NAME)) return;
        this.conclude(step);
      })
      .catch((error: unknown) => {
        adoptionLogger.error({ event: 'sole_meter_adoption_step_failed', err: normalizeError(error) });
        this.finish();
      });
  }

  private async attemptOnce(): Promise<AttemptResult> {
    // Read before the census as well as after it: a settled or half-applied
    // answer needs no fetch, a deferred one is not worth one, and the
    // listed-null grace counts an attempt only when BOTH its reads are null —
    // an explicit id that surfaces on either read restarts the grace.
    const before = this.deps.classifyEligibility();
    const settledBefore = this.concludeWithoutCensus(before);
    if (settledBefore !== null) return settledBefore;
    const census = await this.deps.census();
    // Re-classify AFTER the awaited fetch, so it is the last read before any
    // write: the settings UI is reachable during the retry window, and an
    // owner who chose a source meanwhile has settled the question.
    const eligibility = this.deps.classifyEligibility();
    const listedNull = isListedNull(before) && isListedNull(eligibility);
    this.listedNullReads = listedNull ? this.listedNullReads + 1 : 0;
    const settledAfter = this.concludeWithoutCensus(eligibility);
    if (settledAfter !== null) return settledAfter;
    if (eligibility.kind !== 'eligible') {
      return { result: 'retry', reasonCode: 'reclassify_unexpected', transient: true };
    }
    this.eligibleDetail = eligibility.detail;
    if (census.state === 'unavailable') return { result: 'retry', reasonCode: 'census_unavailable', transient: true };
    if (census.state === 'unresolvable') {
      // A registry that could not corroborate is a read that said nothing; a
      // report listing no meter is an answer that disagrees with a pending
      // one; several meters or nothing nameable end the run.
      if (census.reason === 'registry_mismatch') {
        return { result: 'retry', reasonCode: 'census_registry_mismatch', transient: true };
      }
      return census.reason === 'none_found'
        ? { result: 'retry', reasonCode: 'census_none_found', transient: false }
        : { result: 'not_applicable', reasonCode: `census_${census.reason}` };
    }
    if (census.meterDeviceId !== this.pendingMeterDeviceId) {
      return { result: 'propose', meterDeviceId: census.meterDeviceId };
    }
    if (eligibility.meterKey === 'listed_null' && this.listedNullReads < LISTED_NULL_GRACE_READS) {
      return { result: 'hold', meterDeviceId: census.meterDeviceId };
    }
    return { result: 'confirm', meterDeviceId: census.meterDeviceId };
  }

  /** The answers a classification gives on its own; `null` means the census decides. */
  private concludeWithoutCensus(eligibility: SoleMeterAdoptionEligibility): AttemptResult | null {
    if (eligibility.kind === 'settled') {
      this.listedNullReads = 0;
      return { result: 'settled', detail: eligibility.detail };
    }
    if (eligibility.kind === 'defer') {
      this.listedNullReads = 0;
      return { result: 'retry', reasonCode: `reclassify_${eligibility.reasonCode}`, transient: true };
    }
    if (eligibility.kind === 'complete') {
      this.listedNullReads = 0;
      this.eligibleDetail = 'source_missing';
      return { result: 'complete', meterDeviceId: eligibility.meterDeviceId };
    }
    return null;
  }

  private conclude(step: AttemptResult): void {
    if (step.result === 'settled') {
      adoptionLogger.info({ event: 'sole_meter_adoption_settled_by_owner', detail: step.detail });
      this.finish();
      return;
    }
    if (step.result === 'not_applicable') {
      this.concludeNotApplicable(step.reasonCode);
      return;
    }
    if (step.result === 'confirm') {
      this.confirm(step.meterDeviceId);
      return;
    }
    if (step.result === 'complete') {
      // The meter half is stored, but the source half is what turns the Flow
      // card off: a reading that ever arrived (a Flow may have fed the
      // install between the half-save and a reboot) means the half-save is
      // not completed over it.
      const readings = this.readingsEverOrSinceRun();
      if (readings === 'admitted') {
        this.concludeNotApplicable('readings_already_flowing');
        return;
      }
      if (readings === 'unknown') {
        this.scheduleOrGiveUp('readings_history_unknown');
        return;
      }
      this.write(step.meterDeviceId);
      return;
    }
    if (step.result === 'propose' || step.result === 'hold') {
      adoptionLogger.debug({
        event: 'sole_meter_adoption_confirmation_pending',
        meterDeviceId: step.meterDeviceId,
        attempt: this.attempt,
        ...(step.result === 'hold' ? { listedNullReads: this.listedNullReads } : {}),
      });
      this.pendingMeterDeviceId = step.meterDeviceId;
      this.scheduleOrGiveUp(step.result === 'hold' ? 'listed_null_grace' : 'confirmation_pending');
      return;
    }
    adoptionLogger.debug({
      event: 'sole_meter_adoption_retry_scheduled',
      reasonCode: step.reasonCode,
      attempt: this.attempt,
    });
    // A transient failure is a no-op: the pending meter survives it, and the
    // next usable read that names it confirms. A report that answered without
    // naming it is a disagreement, and only consecutive agreeing reads confirm.
    if (!step.transient) this.pendingMeterDeviceId = null;
    this.scheduleOrGiveUp(step.reasonCode);
  }

  private confirm(meterDeviceId: string): void {
    // An install that chose the Power meter source and never picked a meter
    // cannot have been Flow-fed (Flow samples are dropped on that source), so
    // only a sample since this run counts against it; every other shape asks
    // for the whole history.
    const readings = this.eligibleDetail === 'no_meter_chosen'
      ? this.deps.readingsAdmittedSince(this.startedAtMs)
      : this.readingsEverOrSinceRun();
    if (readings === 'admitted') {
      this.concludeNotApplicable('readings_already_flowing');
      return;
    }
    if (readings === 'unknown') {
      // A history that could not be read at start stays unknown for the run:
      // by now the prune may have persisted the blank in-memory state over
      // it, so a later "never" would be no evidence. Next boot reads again.
      this.scheduleOrGiveUp('readings_history_unknown');
      return;
    }
    this.write(meterDeviceId);
  }

  /**
   * Whether a reading EVER arrived: the answer captured at start (before the
   * prune could erase it), or, when that was "none", whether one arrived
   * since this run began. An install that never wrote the source key and
   * has received a reading was fed by a Flow.
   */
  private readingsEverOrSinceRun(): 'admitted' | 'none' | 'unknown' {
    return this.historyAtStart !== 'none'
      ? this.historyAtStart
      : this.deps.readingsAdmittedSince(this.startedAtMs);
  }

  private write(meterDeviceId: string): void {
    const outcome = this.deps.adopt(meterDeviceId);
    if (outcome.result === 'adopted') {
      adoptionLogger.info({ event: 'sole_meter_adopted', meterDeviceId, detail: this.eligibleDetail });
      this.finish();
      return;
    }
    if (outcome.result === 'not_applicable') {
      this.concludeNotApplicable(outcome.reasonCode);
      return;
    }
    // A degraded save keeps the confirmed meter pending: the next agreeing
    // read retries the write without restarting the confirmation.
    this.scheduleOrGiveUp(outcome.reasonCode);
  }
}
