import type CapacityGuard from '../../power/capacityGuard';
import type { PowerTrackerState } from '../../power/tracker';
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanContext } from '../planContext';
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice, ShedBehavior } from '../planTypes';
import type { PendingBinaryCommandStore } from '../../observer/pendingBinaryCommands';
import type { ShedCandidateSkipSummary } from './candidateSkipLog';

export type SheddingPlan = {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  /**
   * Per stepped device chosen this cycle, the step the shed was PRICED at —
   * the decision materialization commands, not a suggestion it re-derives.
   *
   * This is the same boundary `shedReasons` crosses, and it carries the same
   * kind of thing: a fact about a device this module already selected. It does
   * not let materialization select anything new
   * (`lib/plan/shedding/AGENTS.md`), and it is what makes credited relief equal
   * delivered relief — without it the executor cut a `turn_off` device's whole
   * draw whatever rung selection had spent.
   *
   * Absent for a device with no step decision: a binary or temperature
   * candidate, or the prepared-binary-off stepped candidate whose relief is the
   * off that follows rather than a step change.
   */
  shedStepTargets: Map<string, string>;
  sheddingActive: boolean;
  guardInShortfall: boolean;
  updates: {
    lastInstabilityMs?: number;
    lastRecoveryMs?: number;
    lastShedPlanMeasurementTs?: number;
    lastShedPlanPowerW?: number;
    lastShedPlanShedIds?: Set<string>;
    lastShedPlanAtMs?: number;
    lastShedPlanNeededKw?: number;
    lastOvershootEscalationMs?: number;
    lastOvershootMitigationMs?: number;
  };
  overshootStats: OvershootStats | null;
};

/**
 * The two overshoot questions `resolveSoftOvershootDecision` keeps apart
 * (`lib/plan/planOvershoot.ts`), threaded in together because `buildSheddingPlan`
 * consumes them on DIFFERENT paths:
 *
 * - `shedActionable` gates SELECTION — may this cycle choose devices to limit.
 * - `actionable` gates the shedding-active LATCH — is the house in an overshoot
 *   at all.
 *
 * Wiring the latch to `shedActionable` is what caused the 2026-08-16 restore-all
 * regression. Every restore-side lane stands down while `activeOvershoot` holds
 * — `resolveOffDeviceReason` and `resolveCapacityRestoreBlockReason` both defer
 * to "the caller's own reason stands" — and `applyRestorePlan` reaches its
 * stay-off marking through `sheddingActive`. So a graced cycle that also cleared
 * the latch left NOTHING holding a device that was already limited: it
 * materialized as `keep` and the executor turned it back on. The grace defers a
 * NEW shed; it must never release the ones already in force.
 */
export type SheddingOvershootInput = {
  actionable: boolean;
  shedActionable: boolean;
};

export type OvershootStats = {
  needed: number;
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
  allShedCandidatesExhausted: boolean;
  controlRecoverable: boolean;
  skippedCandidateCount: number;
  skippedCandidateReasons: ShedCandidateSkipSummary['skippedCandidateReasons'];
};

export type SheddingDeps = {
  capacityGuard: CapacityGuard;
  /** Producer-resolved `computeShortfallThreshold` for this build. */
  shortfallThresholdKw: number;
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  // Observer-owned pending-binary-command store; candidate builders read
  // unconfirmed-relief state through `peek(id)` (raw read) instead of
  // touching `state.pendingBinaryCommands[id]` directly.
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  log: (...args: unknown[]) => void;
  debugStructured?: import('../../logging/logger').StructuredDebugEmitter;
  structuredLog?: import('../../logging/logger').Logger;
};

export type PlanSheddingResult = {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  shedStepTargets: SheddingPlan['shedStepTargets'];
  updates: SheddingPlan['updates'];
  overshootStats: SheddingPlan['overshootStats'];
};

export type ShedCandidateParams = {
  devices: PlanInputDevice[];
  /**
   * How badly this cycle wants to shed — NOT a kW quantity to compare against.
   * An exhausted hour passes `Number.POSITIVE_INFINITY` (`buildSheddingPlan`)
   * to mean "maximum severity": `resolveRecentRestoreState` reads it only
   * against `RECENT_RESTORE_OVERSHOOT_BYPASS_KW`, where the sentinel correctly
   * bypasses the recent-restore grace.
   */
  needed: number;
  /**
   * The real kW the cycle has to close, sentinel-free, for consumers that do
   * arithmetic or comparison with it — today the `preemptiveStepDown` ranking
   * key, which asks `chooseShedRung` what rung a FIRST pick would take.
   *
   * Separate from `needed` on purpose: one field cannot be both a severity
   * sentinel and a kW comparand. Fed the sentinel, "the gentlest rung that
   * covers the deficit" has no answer for any rung, so every stepped
   * `turn_off` candidate would rank as an ordinary turn-off.
   *
   * Selection sizes each shed against the deficit still OPEN at that
   * candidate's turn, not against this — see `selectShedDevices`.
   */
  deficitKw: number;
  limitSource: PlanContext['softLimitSource'];
  /**
   * Producer-resolved: MEASURED above the capacity soft limit. Resolved once
   * in `buildSheddingPlan` from the context's predicate, so no candidate walk
   * re-derives breach from a total (an unmeasured cycle is not breached).
   */
  capacityBreached: boolean;
  state: PlanEngineState;
  deps: SheddingDeps;
};

export type BaseShedCandidate = PlanInputDevice & {
  priority: number;
  /**
   * Everything limiting this device can release — for a stepped device its
   * deepest priced rung, not the rung the shed ends up taking. Ranking and the
   * reducible-load stats both read it, so it must not depend on when the
   * candidate is spent.
   */
  effectivePower: number;
  recentlyRestored: boolean;
  unconfirmedRelief: boolean;
};

export type BinaryShedCandidate = BaseShedCandidate & { kind: 'binary' };

/** One step down this device could take, and what the meter says it frees. */
export type PricedShedRung = {
  toStepId: string;
  reliefKw: number;
};

export type SteppedShedCandidate = BaseShedCandidate & {
  kind: 'stepped';
  fromStepId: string;
  /**
   * The priced ladder, gentlest first. Selection picks the rung from here
   * against the deficit still open at this candidate's turn (`chooseShedRung`),
   * which is why the candidate carries the options rather than an answer: at
   * build time every candidate is priced against the same opening deficit, so a
   * rung fixed here over-shoots by whatever earlier picks already covered.
   *
   * Empty for the prepared-binary-off shape, whose relief is the binary off
   * rather than a step change.
   */
  rungs: PricedShedRung[];
  preemptiveStepDown: boolean;
};

export type TemperatureShedCandidate = BaseShedCandidate & {
  kind: 'temperature';
  targetCapabilityId: string;
  shedTemperature: number;
};

export type ShedCandidate = BinaryShedCandidate | SteppedShedCandidate | TemperatureShedCandidate;
