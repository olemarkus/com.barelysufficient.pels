/**
 * Neutral result of materializing one complete plan, and the rebuild outcome
 * that carries it whole.
 *
 * The planner uses these only to report rebuild outcomes; command execution and
 * device I/O remain executor-owned.
 */
export type PlanActuationResult = {
  deviceWriteCount: number;
  commandRequestCount: number;
  /**
   * Devices whose apply THREW (caught per-device; the dispatch continues).
   * Zero writes with failures is "the plan did not take effect", not "the
   * plan had nothing to do" — the silence escalation must not latch its one
   * fail-closed pass on such an outcome.
   */
  deviceApplyFailureCount: number;
};

/**
 * What one plan rebuild did: how long each stage took, what changed against the
 * previous plan, and the actuation result whole. Read by the rebuild scheduler,
 * the silence escalation, and the rebuild trace (`lib/utils/planRebuildTrace.ts`).
 */
export type PlanRebuildOutcome = PlanActuationResult & {
  buildMs: number;
  changeMs: number;
  snapshotMs: number;
  statusMs: number;
  statusWriteMs: number;
  applyMs: number;
  actionChanged: boolean;
  detailChanged: boolean;
  metaChanged: boolean;
  /** This rebuild wrote to, or requested a command from, at least one device. */
  appliedActions: boolean;
  hadShedding: boolean;
  isDryRun: boolean;
  failed: boolean;
  /**
   * True when no plan was built because the wiring layer's build gate was shut
   * (in production: this home has no meter measurement yet), or because app
   * teardown released the snapshot warmup gate. Distinct from `failed` —
   * nothing went wrong, there was simply nothing to plan from — and distinct
   * from a zeroed no-op, which means a plan WAS built and changed nothing.
   */
  gated: boolean;
};
