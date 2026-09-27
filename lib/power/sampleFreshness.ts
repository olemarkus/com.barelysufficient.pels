/**
 * The meter-silence thresholds, owned by `lib/power` because `lib/power` owns
 * the meter and shared with the settings UI's no-readings banner. What they age
 * is the evidence stamp (`resolveMeterEvidenceAtMs`), never a label: the old
 * 3-state freshness label is gone (owner ruling 2026-08-31: staleness is a
 * UI-only banner fact; the planner sees only its gate boolean and kW).
 */
export {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../packages/shared-domain/src/powerFreshness';
