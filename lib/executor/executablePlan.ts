import type {
  PlannedBinaryCommand, PlannedDeviceCommands, PlannedReleaseCommand, PlannedStepBaseline, PlannedSteppedCommand,
  PlannedStepTransition,
} from '../planContract/executionPlan';
import type { SteppedLoadDesiredRuntimeState } from './steppedCommandState';
import type { PlannedTargetCommand as ExecutableTargetIntent } from '../planContract/targetCommand';
import type { EvDeviceIdentity } from '../../packages/shared-domain/src/evPlugState';
import type {
  ObservedDeviceState,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { SteppedStepActuationState } from './steppedLoadActuation';

/**
 * The decomposed snapshot surface the executor consumes: observer-owned
 * observed truth (`ObservedDeviceState`, including the resolved stepped-load
 * profile). Binary writeability is queried at the Actuator boundary.
 * Deliberately narrower than the raw producer
 * `TargetDeviceSnapshot` — the executor is a downstream consumer, so it depends
 * on the decomposed halves, never the full producer snapshot. The full snapshot
 * remains structurally assignable to this, so producers feed it unchanged.
 */
export type ExecutorDeviceSnapshot = ObservedDeviceState
  // The resolved EV identity, joined from device configuration: whether the
  // plug-state gates commandability. The observer record alone carries none, so
  // without it every charger read as commandable while unplugged.
  & EvDeviceIdentity
  & { steppedLoadProfile?: SteppedLoadProfile }
  & { currentOn?: boolean };

/**
 * One device's commands for this cycle are the planner's `PlannedDeviceCommands`,
 * read as the plan emitted them: the executor attaches no command-session state
 * to them, and reads that state from its own session where it is needed.
 *
 * **Each command axis is OMITTED unless the plan drives it**, and reached
 * through its guard below (the stepped axis through the contract's
 * `hasPlannedStep`) — the same discipline `DevicePlanDeviceBase` uses for
 * `currentOn`, so an un-narrowed `intent.binary` read is a hard compile error
 * (TS2339). It replaces four `| null` slots whose absence meant nothing in
 * particular.
 *
 * Scope of that guarantee, stated honestly: it holds at the type level and in
 * `planExecutionDrift.ts`, which narrows and reads. `planExecutorDispatch.ts`
 * narrows once per device (`resolveDeviceCommands`) and then passes `|
 * undefined` locals down, so the appliers still carry their own `if (!intent)`
 * guard — on that path this is closer to a `null`-to-omission rename than a
 * removed re-check. Tightening the appliers to require a command is the
 * remaining step; do not read this docblock as claiming it is already done.
 *
 * Note the producer obligation this drops: `release` used to be a REQUIRED
 * `| null` property, so forgetting it was a compile error (TS2741). With every
 * axis conditional, omitting a spread in `buildExecutableDeviceIntent`
 * (`lib/plan/planExecutionProjection.ts`) compiles cleanly — and `release` is
 * the axis with no positive projection test, since the lifecycle-release suites
 * hand their appliers a hand-built intent. Treat that spread as load-bearing
 * when editing the producer; `PlannedCommandAxes` types each attached command.
 *
 * There is no "which axes does this device have" question here: that is settled
 * upstream (`isSteppedLoadDevice`, `isBinaryPlanDevice`). Presence of a command
 * means the plan wants that axis DRIVEN this cycle, nothing more.
 */
export type ExecutableTargetCommandKind = { target: ExecutableTargetIntent };
export type ExecutableBinaryCommandKind = { binary: ExecutableBinaryIntent };
export type ExecutableReleaseCommandKind = { release: ExecutableReleaseIntent };

/**
 * Command guards. Presence-only, like the observed clusters in shared-domain:
 * the producer attaches a command exactly when the plan drives that axis, so
 * asking "is the key there" IS asking "does the plan drive this axis".
 *
 * Domain-constrained to `PlannedDeviceCommands` on purpose, and the presence
 * test is `!= null` rather than `!== undefined`. `ExecutableObservedDeviceState`
 * in this same file declares `target` and `steppedLoad` with `| null` as its
 * "no axis" spelling, and an observed state sits beside an intent at every
 * consumer — so an unconstrained `<T extends object>` guard would accept
 * `hasTargetCommand(observed)`, return true on `target: null`, and narrow it to
 * a non-nullable command. One identifier's typo, invisible to the compiler.
 */
export const hasTargetCommand = <T extends PlannedDeviceCommands>(
  i: T,
): i is T & ExecutableTargetCommandKind => (
  'target' in i && (i as T & ExecutableTargetCommandKind).target != null
);
export const hasBinaryCommand = <T extends PlannedDeviceCommands>(
  i: T,
): i is T & ExecutableBinaryCommandKind => (
  'binary' in i && (i as T & ExecutableBinaryCommandKind).binary != null
);
export const hasReleaseCommand = <T extends PlannedDeviceCommands>(
  i: T,
): i is T & ExecutableReleaseCommandKind => (
  'release' in i && (i as T & ExecutableReleaseCommandKind).release != null
);

export type ExecutableObservedDeviceState = {
  id: string;
  name: string;
  snapshot: ExecutorDeviceSnapshot;
  available: boolean;
  commandableNow: boolean;
  // The raw observed binary bag, still carried for readers that take it whole.
  // The two questions anyone actually asks of it are answered by the two fields
  // below, each with ONE meaning on every construction path.
  binaryControl?: { on: boolean };
  /**
   * Is the device's on/off HANDLE observed on? The raw binary axis and nothing
   * else — an absent `binaryControl` reads `'on'` ("may draw, stays sheddable",
   * `isBinaryOnOrUnknown`), a stepped device parked at its off step with its
   * switch still armed reads `'on'`.
   *
   * This is the actuation question: `shedReleaseActuation` asks it to decide
   * whether a binary-on still needs issuing, and `lifecycleFallbackDispatcher`
   * to decide whether a binary-off has landed. Writing a switch that is already
   * in the wanted position is the no-op they exist to avoid.
   */
  observedBinaryAxis: 'on' | 'off';
  /**
   * Is the device observed to be DRAWING-capable right now? The producer fold —
   * off when the binary axis reads off OR the stepped axis is parked at its off
   * step (`resolveCurrentOn`, `lib/observer/observedState.ts`).
   *
   * This is the convergence question: drift asks it, because a stepped device at
   * its off rung IS off however its switch reads, and reporting drift there
   * would chase a disagreement that does not exist.
   *
   * The two fields agree for pure-binary devices and diverge only for a
   * binary+stepped device parked at its off step. They were ONE field until the
   * drift P0: its meaning was selected by which path constructed it, so the same
   * read answered differently depending on its caller. Do not merge them again —
   * if a new reader cannot say which of the two questions it is asking, that is
   * the thing to resolve, not the field count.
   */
  observedEffectiveOn: boolean;
  target: ExecutableObservedTargetState | null;
  steppedLoad: ExecutableObservedSteppedLoadState | null;
};

/** The device's primary (temperature) setpoint as observed. */
export type ExecutableObservedTargetState = {
  observedValue: unknown;
};

export type ExecutableObservedSteppedLoadState = {
  on: boolean | null;
  // Producer-resolved EFFECTIVE step (reported, or planning fallback when no
  // report). `reportedStepId` is the real telemetry; when it is absent,
  // `stepId` is the assumed fallback.
  stepId?: string;
  reportedStepId?: string;
  /**
   * The exact target-power watts behind `reportedStepId`, before rung matching
   * (`ReportedStepObservedProbe.reportedStepPowerW`). Absent for a device whose
   * report is not a target-power reading. A `current_before_start` device needs
   * it to tell its prepared rung from an off-ladder limit read as that rung.
   */
  reportedStepPowerW?: number;
  /**
   * Producer-resolved current draw (`getCurrentDrawKw`), REQUIRED. Read by
   * exactly one consumer: `resolveObservedStepForShed` prices an unknown-step
   * `set_step` shed from it when no step id is available. It used to be an
   * optional `measuredPowerKw`, fed the raw snapshot field on one path and an
   * adapted `currentDrawKw` on the other — one name for two provenances, with
   * nothing at either end saying who read it.
   */
  currentDrawKw: number;
};

/**
 * A binary command the plan wants issued: the END STATE of the device's on/off
 * handle, never the category the planner filed it under.
 *
 * **Membership is the answer.** The planner emits the set of devices it drives;
 * one it is not driving this cycle has no intent at all. So there is no "no
 * opinion" value here and `desiredOn` is a strict `boolean` — a nullable would
 * hand the executor back a question the planner already answered.
 *
 * This replaces a `kind: 'shed' | 'restore'` union that made the executor
 * re-derive on/off from the planner's vocabulary, and a `reason?: string` that
 * was a swap label threaded through five signatures only to be stored as
 * metadata on the pending-command record — it decided nothing.
 */
export type ExecutableBinaryIntent = PlannedBinaryCommand;

export type ExecutableReleaseIntent = PlannedReleaseCommand;

export type { PlannedTargetCommand as ExecutableTargetIntent } from '../planContract/targetCommand';

/** A temperature setpoint write: the desired value against the observed one. */
export type ExecutableTargetCommand = {
  deviceId: string;
  name: string;
  desired: number;
  observedValue: unknown;
};

export type ExecutableTargetUpdate = ExecutableTargetCommand & {
  isRestoring: boolean;
};

export type ExecutableSteppedLoadTransition = PlannedStepTransition;

/**
 * An outstanding step command of this layer's own — see
 * `resolveSteppedCommandAttempt`. `awaiting_power_settle` used to be in this union
 * and was structurally unreachable: the executor built this by calling the planner
 * helper WITHOUT a write clock, so the meter-settle branch could never fire. The
 * meter question is not the executor's, so the variant is gone rather than wired up.
 */
export type ExecutableSteppedCommandAttempt = {
  status: 'awaiting_confirmation' | 'retry_backoff';
  requestedStepId: string;
} | null;

/**
 * A stepped device's current on/step. The base of the projection's current
 * state, and on its own the producer-resolved fallback the device-projection
 * uses ONLY when the device has no observation this cycle (no descriptor or no
 * observer record for it between planning and dispatch — `executorDeviceRead.ts`).
 * The observed-state producer owns that resolution from the plan device's
 * kind-aware observed-state predicates and `selectedStepId`; the executor never
 * re-derives a planning fallback. When an observation exists, the observed
 * state is authoritative and the fallback is ignored.
 */
export type ExecutableSteppedLoadState = PlannedStepBaseline;

export type ExecutableSteppedLoadCurrentState = ExecutableSteppedLoadState & {
  stepForShed?: {
    stepId: string;
    planningPowerW: number;
  };
  stepIsOffStep: boolean;
};


/** The planned step command as the executor dispatches it. */
export type ExecutableSteppedLoadIntent = PlannedSteppedCommand;

/**
 * One stepped device ready to command this cycle: the intent with this cycle's
 * resolved `desired` / `transition` (an unknown running step is seeded at the
 * lowest active rung), the current state it is commanded from, whether the
 * requested step has materialized, and the executor's outstanding command for
 * the planned step (`resolveSteppedCommandAttempt` against the command session),
 * which the restore lane and the command lane both read: one attempt, one answer.
 */
export type ExecutableSteppedLoadDevice = {
  intent: ExecutableSteppedLoadIntent;
  current: ExecutableSteppedLoadCurrentState;
  stepActuation: SteppedStepActuationState;
  stepNeedsAdjustment: boolean;
  matchingCommandAttempt: ExecutableSteppedCommandAttempt;
};

/**
 * The step a command for `action` moves the device from: its current one, or
 * none while an unknown running step is seeded at the lowest rung.
 */
export const resolveCommandPreviousStepId = (action: ExecutableSteppedLoadDevice): string | undefined => (
  action.intent.transition?.effectiveTransition === 'initialize_unknown_step_at_low'
    ? undefined
    : action.current.stepId
);

export type ExecutableSteppedLoadCommandSession = {
  /** The executor's tracked command, independent of the plan's historical inputs. */
  command?: Pick<SteppedLoadDesiredRuntimeState, 'stepId' | 'status' | 'retryCount' | 'nextRetryAtMs'>;
  initializationAssumedStepId?: string;
  hasPriorStepCommand: boolean;
  reportedStepId?: string;
  /** Commanded-axis: a step command is issued and not yet settled. */
  stepCommandPending: boolean;
  /** The tracked step command, when the device has reported nothing back to commands for it. */
  unansweredStepCommands: UnansweredStepCommands;
};

/** A step the device was asked for, and how many commands for it in a row drew no report of any level. */
export type UnansweredStepCommands =
  | { kind: 'none' }
  | { kind: 'unanswered'; stepId: string; count: number };
