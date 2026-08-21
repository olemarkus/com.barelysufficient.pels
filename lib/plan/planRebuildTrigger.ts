/**
 * The complete set of things that may cause PELS to re-decide.
 *
 * A **device observation is deliberately absent**, and that absence is the whole
 * point of this file. An observed device change is planner INPUT, not a reason to
 * re-run a capacity decision: the decision is about the whole-home reading, and a
 * rebuild driven by a device event runs against a reading that never saw it. The
 * reading arrives on its own cadence and carries the change with it. See root
 * `AGENTS.md` § Control Flow.
 *
 * What an observation MAY do is invalidate a rebuild suppression, so the reading
 * already on its way is not throttled away
 * (`setup/appInit/planObservedStateSubscription.ts`). Invalidating a suppression
 * is not triggering a rebuild: it changes WHETHER the next measurement decides,
 * never WHAT it decides from.
 *
 * Adding a name here is the deliberate act it should be. Do not reach for a
 * free-form string, and do not add an observation trigger back without changing
 * that document first.
 *
 * The `reason` it replaces was never purely decorative — three call sites read
 * it back: `resolveRestoreDecisionPhase` (startup vs runtime restore admission),
 * `isTightReason` (tight-noop backoff bookkeeping), and `getPlanRebuildLogLevel`,
 * which additionally sniffed `startsWith('settings:')`. Each matched raw strings
 * that nothing guaranteed a caller would spell the same way.
 */

/**
 * Resolved by the power lane's own policy (`rebuildScheduler/policy.ts`) from the
 * sample it just admitted. These are the only triggers whose subject is the
 * whole-home reading itself.
 */
export const POWER_SAMPLE_REBUILD_TRIGGERS = [
  'initial',
  'shortfall',
  'hard_cap_breach',
  'headroom_tight',
  'power_sample_convergence',
  'power_delta',
  'max_interval',
  /** The policy wanted a rebuild but no branch claimed it; kept so that stays visible. */
  'unknown',
] as const;

export type PowerSampleRebuildTrigger = (typeof POWER_SAMPLE_REBUILD_TRIGGERS)[number];

export const PLAN_REBUILD_TRIGGERS = [
  ...POWER_SAMPLE_REBUILD_TRIGGERS,

  // The power lane speaking about the ABSENCE of a reading — and the ONE thing
  // it is allowed to say. Fires once, at `POWER_SAMPLE_STALE_SHED_TIMEOUT_MS`
  // (10 minutes) with no sample, so the planner runs and sheds instead of holding
  // an "under cap" decision taken before the meter died
  // (`setup/powerSampleFreshnessEscalation.ts`). Everything short of that window
  // is a no-op: the last good reading carries forward. A clock is needed because
  // a whole-home reading is now the primary trigger, so when the meter is what
  // died, nothing else is guaranteed to fire.
  'freshness_heartbeat',

  // An input other than the reading changed, so a re-decision is owed regardless
  // of how current the reading is. Each of these carries a `detail`.
  'settings',
  'price',
  'flow_card',

  // Startup and per-home lifecycle.
  'startup_snapshot_bootstrap',
  'home_bundle_created',
  'home_membership_ready',
  'home_membership_changed',
  'home_membership_settled',
  'home_ownership_ready',
  'home_ownership_generation_prepared',
  'home_source_authority_recovered',

  // What PELS is able to command changed.
  'binary_command_reachability_changed',
  'binary_command_reachability_deadline',
  'target_power_reachability_updated',
  'target_power_probe_due',
  'native_wiring_auto_decision',
] as const;

export type PlanRebuildTrigger = (typeof PLAN_REBUILD_TRIGGERS)[number];


export type PlanRebuildRequestOptions = {
  /**
   * Narrows an open-ended trigger for the log line: the settings key that moved,
   * the flow card that fired, the price mode that resolved. Free text on purpose
   * — those sets are genuinely unbounded — and it reaches the log and nothing
   * else. No decision, counter, or gate reads it.
   */
  detail?: string;
  shouldAbort?: () => boolean;
  onAbort?: () => void;
};

/**
 * The log label for a rebuild. Composed rather than passed, so the trigger stays
 * a closed value everywhere a decision touches it while logs keep the exact
 * strings they have always carried.
 */
export const describePlanRebuildTrigger = (
  trigger: PlanRebuildTrigger,
  detail?: string,
): string => {
  if (detail === undefined) return trigger;
  // The one label that is a sentence rather than a path.
  if (trigger === 'price') return `price optimization (${detail} hour)`;
  return `${trigger}:${detail}`;
};
