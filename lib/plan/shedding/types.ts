import type CapacityGuard from '../../power/capacityGuard';
import type { PowerTrackerState } from '../../power/tracker';
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanContext } from '../planContext';
import type { PlanEngineState, SheddingOutcome, StorageLeverState } from '../planState';
import type { MeteredPlanInputDevice, PlanInputDevice, ShedBehavior } from '../planTypes';
import type { PendingBinaryCommandStore } from '../../observer/pendingBinaryCommands';
import type { ShedCandidateSkipSummary } from './candidateSkipLog';
import type { TemperatureSetpointsByDevice } from '../../../packages/planner-types/src/temperatureSetpoints';
import type { ObservedStorageInput } from '../../../packages/planner-types/src/planInputDevice';

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
  /**
   * Per home battery chosen this cycle, the signed setpoint its limit was
   * priced at, W (`StorageShedCandidate`): a capped charge, or a discharge;
   * and whether selection banked its relief. An unbanked ask (a re-probing
   * battery, or one not following its limit) opens no credit window.
   * The same kind of boundary `shedStepTargets` crosses, a fact about a device
   * this module already selected, and like it the delivered decision: the
   * battery stage (`lib/plan/battery/storageLimit.ts`) holds the battery
   * there and never re-prices it. A battery is never in `shedSet`, so the
   * executor never sees a shed for it; this map is the only way its limit
   * leaves shedding. Required, so a carrier that drops it does not compile.
   */
  storageSetpoints: Map<string, StorageSetpoint>;
  sheddingActive: boolean;
  guardInShortfall: boolean;
  outcome: SheddingOutcome;
  /** When this cycle's guard update released the shedding latch, or null when it did not. */
  recoveredAtMs: number | null;
  overshootStats: OvershootStats | null;
};

/**
 * The setpoint a battery's limit was spent at, W, whether its relief was
 * banked, and the battery as its candidate read it this cycle.
 */
export type StorageSetpoint = { setpointW: number; banked: boolean; storage: ObservedStorageInput };

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

/**
 * What the battery stage before shedding (`lib/plan/battery/storageRelief.ts`)
 * hands shedding: a DECISION about the deficit, never a rewrite of the
 * measurement. Shedding, and the overshoot grace that gates it, count it
 * against the measured deficit; the shortfall verdict, incidents and every
 * other stage see the measurement alone. Only discharge is here: a charge a
 * battery limit stopped is pending relief's credit (`pendingRelief.ts`).
 */
export type StorageShedTerm = {
  /**
   * Relief to take off the measured deficit, kW: discharge a battery's limit
   * hold asked for and has not delivered yet, less the discharge of every
   * battery handed back this cycle, whose import lands next. Negative when a hand-back
   * outweighs the credit, so shedding is ready before the import step shows.
   */
  netCreditKw: number;
  /** A battery holds a discharge this cycle, so it may answer an exhausted hour. */
  relieving: boolean;
  /**
   * The import a relieving battery deliberately leaves under the house's draw
   * (half its deadband, so relief never tips the house into export), kW. An
   * exhausted hour forgives it.
   */
  drawMarginKw: number;
};

/** No battery relieving and none released: shedding exactly as without one. */
export const NO_STORAGE_SHED_TERM: StorageShedTerm = Object.freeze({
  netCreditKw: 0,
  relieving: false,
  drawMarginKw: 0,
});

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
  shortfallThresholdKw: number | null;
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
  storageSetpoints: SheddingPlan['storageSetpoints'];
  outcome: SheddingOutcome;
  overshootStats: SheddingPlan['overshootStats'];
  /**
   * Relief a recent shed counted on that this cycle's reading does not show yet
   * and that the cycle credited (`pendingRelief.ts`); 0 when none was. Relief
   * still on its way, as far as the hard-cap verdict is concerned.
   */
  pendingReliefKw: number;
};

export type ShedCandidateParams = {
  bypassRecentRestore: boolean;
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
   * Producer-resolved: measured above an enabled capacity or grid threshold.
   * Resolved once in `buildShedCandidateParams`, so no candidate walk
   * re-derives breach from a total (an unmeasured cycle is not breached).
   */
  capacityBreached: boolean;
  /** The build's resolved setpoints (`PlanContext.temperatureSetpoints`): whether a setpoint limit releases demand. */
  temperatureSetpoints: TemperatureSetpointsByDevice;
  /**
   * Whether a home battery may be offered as a candidate, the house draw its
   * discharge is bounded by, and the holds this cycle's storage stage left
   * (`StorageRelief.levers`), which a held battery is priced from: only on a
   * measured cycle. The silent-meter pass has no draw to bound a discharge by
   * and hands every battery back.
   */
  storageLimit: StorageLimitInput;
  state: PlanEngineState;
  deps: SheddingDeps;
};

/** See `ShedCandidateParams.storageLimit`. */
export type StorageLimitInput =
  | { kind: 'measured'; drawKw: number; levers: Readonly<Record<string, StorageLeverState>> }
  | { kind: 'unmeasured' };

export type BaseShedCandidate = MeteredPlanInputDevice & {
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

/** A load candidate: a device the generic shed lanes command. */
export type LoadShedCandidate = BinaryShedCandidate | SteppedShedCandidate | TemperatureShedCandidate;

/**
 * A home battery, offered at its own place in the priority order
 * (`storageCandidate.ts`). Its limiting ladder runs from its charge, through
 * 0 W, to its deepest discharge: limiting it first caps its charge, then
 * discharges it, in one decision. It carries no load fields: it is never in
 * the shed set and the executor never sees a shed for it.
 */
export type StorageShedCandidate = {
  kind: 'storage';
  id: string;
  name: string;
  priority: number;
  /** Everything its ladder can release below `baseW`, kW: ranking and stats read it. */
  effectivePower: number;
  recentlyRestored: boolean;
  /**
   * A re-probing battery, or one that has not followed its limit within the
   * credit's window: still asked, but its relief is not banked.
   */
  unconfirmedRelief: boolean;
  /**
   * The limit hold PELS keeps on it already, or none: an unconfirmed battery
   * PELS holds is re-asserted at that setpoint, never asked deeper.
   */
  hold: { kind: 'none' } | { kind: 'limit'; setpointW: number };
  storage: ObservedStorageInput;
  /**
   * Where the ladder is priced from, W: the battery's own signed power, or the
   * setpoint PELS already holds it at when that is lower (relief already
   * decided is credited elsewhere, never offered again).
   */
  baseW: number;
};

export type ShedCandidate = LoadShedCandidate | StorageShedCandidate;
