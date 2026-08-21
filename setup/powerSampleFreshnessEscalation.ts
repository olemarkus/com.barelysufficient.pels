import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../lib/power/sampleFreshness';
import { normalizeError } from '../lib/utils/errorUtils';
import type { AppContext } from '../lib/app/appContext';
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
  getLastSampleAtMs: () => number | undefined;
  isTornDown: () => boolean;
  /**
   * Whether this home's meter is being sampled at all right now. Escalation is
   * suspended when it is not: an orphaned timestamp that can never be refreshed
   * must not keep aging into a shed on a dead reading.
   */
  isMeterSampled: () => boolean;
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
 * Bounded by design: an in-flight latch (no overlapping rebuild), and exactly one
 * rebuild per stale period, tracked by the sample timestamp the escalation was
 * taken against. It polls on an interval only to notice the window opening; the
 * escalation itself is the one-shot.
 */
export function installPowerSampleFreshnessEscalation(params: FreshnessEscalationParams): void {
  const {
    ctx, homeId, timerKey, logger, rebuild, getLastSampleAtMs, isTornDown, isMeterSampled,
  } = params;
  let inFlight = false;
  let escalatedForTs: number | null = null;

  const maybeEscalate = (): void => {
    if (isTornDown() || inFlight) return;
    if (!isMeterSampled()) return;
    const lastTs = getLastSampleAtMs();
    if (typeof lastTs !== 'number' || !Number.isFinite(lastTs)) return;
    if (Date.now() - lastTs < POWER_SAMPLE_STALE_SHED_TIMEOUT_MS) return;
    // Already escalated this stale period; do not re-run the same shed.
    if (escalatedForTs === lastTs) return;
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
        // Still stale on completion (a sample racing in would have moved the
        // timestamp): mark this period escalated so it does not re-run.
        if (getLastSampleAtMs() === lastTs) escalatedForTs = lastTs;
      })
      .catch((error: unknown) => {
        logger()?.error({ event: 'home_freshness_heartbeat_rebuild_failed', homeId, err: normalizeError(error) });
      })
      .finally(() => { inFlight = false; });
  };

  ctx.timers.registerInterval(timerKey, setInterval(maybeEscalate, freshnessEscalationIntervalMs(homeId)));
}
