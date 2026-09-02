import { normalizeError } from '../lib/utils/errorUtils';
import type { AppContext } from '../lib/app/appContext';
import type { MeterSilenceMonitor } from '../lib/power/meterSilence';
import type { PlanRebuildOutcome } from '../lib/plan/planTypes';
import type { HomeId } from '../lib/utils/settingsKeys';

const BASE_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 5000 : 30 * 1000;

/**
 * Per-home jitter so every bundle does not escalate on one phase-aligned tick.
 * Deterministic per `homeId` so a restart does not reshuffle the fleet.
 */
export const freshnessEscalationIntervalMs = (homeId: HomeId): number => {
  let hash = 0;
  for (let index = 0; index < homeId.length; index += 1) {
    hash = (hash * 31 + homeId.charCodeAt(index)) >>> 0;
  }
  const jitterMs = hash % Math.max(1, Math.floor(BASE_INTERVAL_MS / 4));
  return BASE_INTERVAL_MS + jitterMs;
};

export type FreshnessEscalationParams = {
  ctx: AppContext;
  homeId: HomeId;
  timerKey: string;
  logger: () => ReturnType<AppContext['getStructuredLogger']>;
  rebuild: () => Promise<PlanRebuildOutcome>;
  /**
   * This home's silence policy: owns "is the one shed pass still owed" and
   * the completed-pass latch, shared with the composed plan-build gate so the
   * pass this clock runs is exactly the one the gate lets through.
   */
  meterSilence: MeterSilenceMonitor;
  getLastSampleAtMs: () => number | undefined;
  isTornDown: () => boolean;
  /**
   * Whether this home's meter is being sampled at all right now. Escalation is
   * suspended when it is not: an orphaned timestamp that can never be refreshed
   * must not keep aging into a shed on a dead reading.
   */
  isMeterSampled: () => boolean;
  /**
   * Whether the last committed full device read listed any device
   * (`DeviceTransport.hasWarmSnapshot`). The pass is refused —
   * and stays owed — while it has not: the boot fetch can fail and the warmup
   * gate then releases on `timeout` with an empty snapshot, and a pass run
   * against that "succeeds" with nothing governed, latches, and engages the
   * block until data returns — so the devices the 5-minute poll then lands
   * are never shed. The stamp-only outage clock (`lib/power/meterSilence.ts`)
   * makes this the ordinary post-outage reboot, not an edge case.
   */
  isSnapshotWarm: () => boolean;
  /**
   * Whether this home's final write seam is fenced right now (the same
   * predicate `createFencedActuator` consults). A fenced write answers
   * `requested: false` and is not an apply failure, so a pass run while fenced
   * would latch with nothing written; refusing it keeps the pass owed.
   */
  isActuationFenced: () => boolean;
};

/**
 * The one clock a home keeps for its own meter going silent.
 *
 * It is not a heartbeat and it does not re-plan on ordinary staleness. It fires
 * **once**, at `POWER_SAMPLE_STALE_SHED_TIMEOUT_MS` (10 minutes) with no reading,
 * so the planner runs and sheds rather than holding an "under cap" decision taken
 * before the meter died. Everything short of that window is a no-op: the last
 * good reading carries forward, exactly as root `AGENTS.md` requires of a
 * transient external failure.
 *
 * A clock is needed rather than riding on other triggers because a whole-home
 * meter reading is now the primary rebuild trigger (`lib/plan/planRebuildTrigger.ts`).
 * When the meter is the thing that died, nothing else is guaranteed to fire —
 * a quiet install may see no settings write and no price hour for a long time.
 *
 * The pass is only ever spent where it can shed: with a full device read
 * committed and the write seam open (`isSnapshotWarm`, `isActuationFenced`).
 * Otherwise it stays owed and the clock retries — never latching a pass that
 * governed or wrote nothing, since the latch is what engages the block.
 *
 * Bounded by design: an in-flight latch (no overlapping rebuild), and exactly one
 * rebuild per stale period, latched in the home's `MeterSilenceMonitor` against
 * the sample timestamp the escalation was taken against — the same monitor the
 * composed plan-build gate reads, so after the pass every further rebuild is
 * blocked until an admitted sample returns. It polls on an interval only to
 * notice the window opening; the escalation itself is the one-shot.
 */
export function installPowerSampleFreshnessEscalation(params: FreshnessEscalationParams): void {
  const {
    ctx, homeId, timerKey, logger, rebuild, meterSilence, getLastSampleAtMs, isTornDown, isMeterSampled,
    isSnapshotWarm, isActuationFenced,
  } = params;
  let inFlight = false;

  const maybeEscalate = (): void => {
    if (isTornDown() || inFlight) return;
    if (!isMeterSampled()) return;
    // The one-shot policy — silence past the timeout on the stamp's own clock
    // (a restart does not reset it), exactly one owed pass — lives in the
    // monitor, shared with the composed plan-build gate.
    if (!meterSilence.shouldRunShedPass()) return;
    // The pass exists to shed. Refuse it — it stays owed and the next tick
    // retries — while it provably could not: no full device read has committed
    // (a boot-time SDK failure leaves an empty snapshot until the 5-minute poll),
    // or the write seam is fenced (every write would answer `requested: false`).
    if (!isSnapshotWarm()) {
      logger()?.warn({ event: 'home_freshness_heartbeat_snapshot_cold', homeId });
      return;
    }
    if (isActuationFenced()) {
      logger()?.warn({ event: 'home_freshness_heartbeat_actuation_fenced', homeId });
      return;
    }
    const lastTs = getLastSampleAtMs();
    if (typeof lastTs !== 'number' || !Number.isFinite(lastTs)) return;
    inFlight = true;
    void rebuild()
      .then((outcome) => {
        // Latch this stale period ONLY after a rebuild that both SUCCEEDED and
        // actually ACTUATED. `rebuildPlanFromCache` RESOLVES `{ failed: true }` on a
        // build error (it never throws), and runs forced-dry-run during the boot
        // gate. In either case the shed did NOT take effect, so latching would
        // suppress the retry the next tick owes.
        if (outcome.failed) {
          logger()?.warn({ event: 'home_freshness_heartbeat_rebuild_failed', homeId });
          return;
        }
        if (outcome.isDryRun) {
          logger()?.debug({ event: 'home_freshness_heartbeat_rebuild_dry_run_skipped', homeId });
          return;
        }
        if (outcome.gated) {
          logger()?.debug({ event: 'home_freshness_heartbeat_rebuild_gated_skipped', homeId });
          return;
        }
        if (outcome.deviceApplyFailureCount > 0) {
          // The build succeeded but one or more device writes threw (caught
          // per-device by the executor): the fail-closed shed did not fully
          // take effect, so the pass stays owed and the next tick retries —
          // latching here would engage the block with load still running.
          logger()?.warn({
            event: 'home_freshness_heartbeat_apply_failed',
            homeId,
            deviceApplyFailureCount: outcome.deviceApplyFailureCount,
          });
          return;
        }
        // The preconditions are re-judged at completion: a fence that closed
        // (or a snapshot that went cold) DURING the rebuild turned its writes
        // into `requested: false` no-ops, which count as neither writes nor
        // failures, so latching now would engage the block with load still
        // running. A fence that closed and reopened inside one rebuild is the
        // residual this cannot see; the executor does not report fenced writes.
        if (!isSnapshotWarm() || isActuationFenced()) {
          logger()?.warn({ event: 'home_freshness_heartbeat_precondition_lost', homeId });
          return;
        }
        // Still stale on completion (a sample racing in would have moved the
        // timestamp): latch the pass, which also engages the block until data
        // returns.
        if (getLastSampleAtMs() === lastTs) meterSilence.noteShedPassCompleted(lastTs);
      })
      .catch((error: unknown) => {
        logger()?.error({ event: 'home_freshness_heartbeat_rebuild_failed', homeId, err: normalizeError(error) });
      })
      .finally(() => { inFlight = false; });
  };

  ctx.timers.registerInterval(timerKey, setInterval(maybeEscalate, freshnessEscalationIntervalMs(homeId)));
}
