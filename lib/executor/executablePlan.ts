import type { DesiredBinaryKind } from './executableDesiredState';
import type {
  DeviceControlAdapterSnapshot,
  DeviceDescriptor,
  ObservedDeviceState,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { SteppedStepActuationState } from './steppedLoadActuation';

/**
 * The plan's shed end state for a stepped device, as this layer holds it: the
 * producer-decided kind (`DevicePlanDevice.plannedShedTargetKind`, resolved in
 * `lib/plan`) paired with the step the EXECUTOR resolved for it — the
 * transition's command step, else the planned step, which can differ from the
 * plan's own `desiredStepId`. Absent when the device is not shed this cycle.
 *
 * The executor pairs; it never decides the kind. The planner's shed-policy
 * discriminant is not reachable from this layer at all — a device's configured
 * shed behaviour is a FLOOR, the deepest the planner may go, so it cannot be
 * re-read here as this cycle's decision (`lib/executor/AGENTS.md`).
 */
export type ExecutableShedTarget =
  | { kind: 'binary_off' }
  | { kind: 'step'; stepId: string | undefined }
  | { kind: 'target_value' };

export type ExecutablePlan = {
  devices: ExecutableDeviceIntent[];
};

/**
 * The decomposed snapshot surface the executor consumes: observer-owned
 * observed truth (`ObservedDeviceState`) plus the descriptor config its
 * actuation gates read (commandability and the stepped-load ladder).
 * Deliberately narrower than the raw producer
 * `TargetDeviceSnapshot` — the executor is a downstream consumer, so it depends
 * on the decomposed halves, never the full producer snapshot. The full snapshot
 * remains structurally assignable to this, so producers feed it unchanged.
 */
export type ExecutorDeviceSnapshot = ObservedDeviceState
  & Pick<
    DeviceDescriptor,
    | 'capabilities'
    | 'canSetControl'
    | 'communicationModel'
    | 'deviceClass'
  >
  & SteppedLoadDescriptorProbe
  & { currentOn?: boolean; commandableNow?: boolean };

/**
 * One device's commands for this cycle.
 *
 * **Each command axis is OMITTED unless the plan drives it**, and reached
 * through its guard below — the same discipline `DevicePlanDeviceBase` uses for
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
 * axis conditional, omitting a spread in `buildExecutableDeviceIntent` compiles
 * cleanly — and `release` is the axis with no positive projection test, since
 * the lifecycle-release suites hand their appliers a hand-built intent. Treat
 * that spread as load-bearing when editing the producer.
 *
 * There is no "which axes does this device have" question here: that is settled
 * upstream (`isSteppedLoadDevice`, `isBinaryPlanDevice`). Presence of a command
 * means the plan wants that axis DRIVEN this cycle, nothing more.
 */
export type ExecutableDeviceIntent = {
  id: string;
  name: string;
  controllable: boolean;
  /** Set only by the projection's failure path; the device carries no commands. */
  projectionError?: unknown;
};

export type ExecutableTargetCommandKind = { target: ExecutableTargetIntent };
export type ExecutableBinaryCommandKind = { binary: ExecutableBinaryIntent };
export type ExecutableReleaseCommandKind = { release: ExecutableReleaseIntent };
export type ExecutableSteppedCommandKind = { steppedLoad: ExecutableSteppedLoadIntent };

/**
 * Command guards. Presence-only, like the observed clusters in shared-domain:
 * the producer attaches a command exactly when the plan drives that axis, so
 * asking "is the key there" IS asking "does the plan drive this axis".
 *
 * Domain-constrained to `ExecutableDeviceIntent` on purpose, and the presence
 * test is `!= null` rather than `!== undefined`. `ExecutableObservedDeviceState`
 * in this same file declares `target` and `steppedLoad` with `| null` as its
 * "no axis" spelling, and an observed state sits beside an intent at every
 * consumer — so an unconstrained `<T extends object>` guard would accept
 * `hasTargetCommand(observed)`, return true on `target: null`, and narrow it to
 * a non-nullable command. One identifier's typo, invisible to the compiler.
 */
export const hasTargetCommand = <T extends ExecutableDeviceIntent>(
  i: T,
): i is T & ExecutableTargetCommandKind => (
  'target' in i && (i as T & ExecutableTargetCommandKind).target != null
);
export const hasBinaryCommand = <T extends ExecutableDeviceIntent>(
  i: T,
): i is T & ExecutableBinaryCommandKind => (
  'binary' in i && (i as T & ExecutableBinaryCommandKind).binary != null
);
export const hasReleaseCommand = <T extends ExecutableDeviceIntent>(
  i: T,
): i is T & ExecutableReleaseCommandKind => (
  'release' in i && (i as T & ExecutableReleaseCommandKind).release != null
);
export const hasSteppedCommand = <T extends ExecutableDeviceIntent>(
  i: T,
): i is T & ExecutableSteppedCommandKind => (
  'steppedLoad' in i && (i as T & ExecutableSteppedCommandKind).steppedLoad != null
);

/**
 * The narrow, executor-facing view of one planned device that the convergence
 * predicates (`executorConvergence.ts`) compare: identity, the observation the
 * plan snapshot recorded, and the end state the plan decided.
 *
 * Deliberately NOT the plan device — `lib/AGENTS.md` § Layer boundaries: "Avoid
 * passing broad planner device shapes into executor modules." In particular it
 * carries no shed-policy discriminant: the desired end state per axis is
 * resolved once, in the producer (`buildExecutableConvergenceDevice`), so the
 * predicates converge onto a decision instead of re-deriving it.
 *
 * Each observed axis is `null` exactly when the device does not have that axis
 * this cycle, mirroring the plan-device facet guards it is projected through.
 */
export type ExecutableConvergenceDevice = {
  id: string;
  /** "Not known to be unavailable" — the plan device's own optimistic read. */
  available: boolean;
  observedState: string;
  observedBinaryOn: boolean | null;
  observedTarget: number | null;
  observedStep: { selectedStepId: string; reportedStepId: string | undefined } | null;
  /** The step the plan wants this device parked at, when it wants one. */
  desiredStepId: string | undefined;
  /** The binary state the plan demands of this device, when it demands one. */
  desiredBinaryState: 'on' | 'off' | null;
  /** The setpoint the plan wants written to this device, when it wants one written. */
  desiredTarget: number | null;
};

export type ExecutableObservedState = {
  devices: ExecutableObservedDeviceState[];
};

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

export type ExecutableObservedTargetState = {
  target: 'temperature';
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
export type ExecutableBinaryIntent = DesiredBinaryKind & {
  deviceId: string;
  name: string;
  /**
   * MANAGED -> UNMANAGED path ONLY, and the last provenance field on this type.
   *
   * `uncontrolled` marks the one case where PELS must undo its OWN prior
   * actuation: a device PELS had shed while it was managed, whose Power-limit
   * control the owner then turned off. Without this release it stays off
   * forever, because shed selection does not consult commandability while both
   * restore paths do. `applyUncontrolledBinaryRestore` gates it on
   * `state.shedDecidedMs`, so it can only ever fire for a shed PELS itself
   * decided.
   *
   * It is NOT a general "is this device controllable" flag and must not be read
   * as one. It belongs on `ExecutableReleaseIntent` beside `binary_release` /
   * `shed_release`, which is where the release semantics already live; it stays
   * here for now because moving it is a behavioural change to the one path that
   * keeps a device from being stranded off.
   */
  source: 'controlled' | 'uncontrolled';
};

export type ExecutableReleaseIntent = {
  kind: 'binary_restore' | 'binary_release' | 'shed_release';
  deviceId: string;
  name: string;
  // Producer-resolved release-cascade target step (configured `shedBehavior.stepId` →
  // lowest-active → off-step). Populated only for `shed_release` on a stepped device whose
  // configured shedBehavior is `set_step`; null otherwise (including for binary release/restore).
  // The lifecycle-end release executor reads this directly instead of re-running the
  // cascade at apply time.
  releaseShedStepId?: string | null;
};

export type ExecutableTargetIntent = {
  deviceId: string;
  name: string;
  desired: number;
  communicationModel?: 'local' | 'cloud';
  purpose: 'target_update' | 'shed_temperature';
};

export type ExecutableTargetCommand = {
  deviceId: string;
  name: string;
  target: 'temperature';
  desired: number;
  observedValue: unknown;
  communicationModel?: 'local' | 'cloud';
};

export type ExecutableTargetUpdate = ExecutableTargetCommand & {
  isRestoring: boolean;
};

export type ExecutableSteppedLoadTransition = {
  effectiveTransition:
    | 'full_shed_to_off'
    | 'restore_from_off_at_low'
    | 'initialize_unknown_step_at_low'
    | 'step_down_while_on'
    | 'step_up_while_on'
    | 'steady';
  stepPreparationPurpose: 'prepare_for_off' | 'prepare_for_on' | 'initialize_unknown_step' | null;
  binaryTarget: boolean | null;
  commandStepId: string | undefined;
  plannedDesiredStepId: string | undefined;
  transitionPhase: 'step_preparation' | 'binary_transition' | 'settled';
};

export type ExecutableSteppedLoadRestoreAttempt = {
  status: 'awaiting_confirmation' | 'awaiting_power_settle' | 'retry_backoff';
  requestedStepId: string;
} | null;

export type ExecutableSteppedLoadState = {
  on: boolean | null;
  stepId?: string;
};

export type ExecutableSteppedLoadCurrentState = ExecutableSteppedLoadState & {
  stepForShed?: {
    stepId: string;
    planningPowerW: number;
  };
  stepIsOffStep: boolean;
};

/**
 * What the plan wants a stepped device's STEP axis to be. The binary axis is
 * NOT here: it rides `DesiredBinaryKind` on the intent, attached only when this
 * cycle's decision actually moves the on/off handle, so an un-narrowed read is
 * a compile error rather than a `boolean | null` every consumer re-interprets.
 */
export type ExecutableSteppedLoadDesiredState = {
  stepId?: string;
  plannedStepId?: string;
};

/**
 * Producer-resolved current state used by the device-projection ONLY when the
 * device has no observation this cycle (absent from `getSnapshot()` between
 * planning and dispatch). The observed-state producer owns the resolution from
 * the plan device's effective values (`resolveEffectiveCurrentOn` /
 * `selectedStepId`); the executor never re-derives a planning fallback. When an
 * observation exists, the observed state is authoritative and this is ignored.
 */
export type ExecutableSteppedLoadCurrentFallback = {
  on: boolean | null;
  stepId?: string;
};

export type ExecutableSteppedLoadIntent = {
  id: string;
  name: string;
  steppedLoadProfile: SteppedLoadProfile;
  communicationModel?: 'local' | 'cloud';
  controlAdapter?: DeviceControlAdapterSnapshot;
  /** This cycle's shed end state — see `ExecutableShedTarget`. */
  plannedShedTarget?: ExecutableShedTarget;
  desired: ExecutableSteppedLoadDesiredState;
  previousStepId?: string;
  transition: ExecutableSteppedLoadTransition | null;
  matchingRestoreAttempt: ExecutableSteppedLoadRestoreAttempt;
  matchingCommandAttempt: ExecutableSteppedLoadRestoreAttempt;
  stepCommandRetryCount: number;
  nextStepCommandRetryAtMs?: number;
  // Step of the last issued step command when that command was confirmed by
  // device-side feedback (`stepCommandStatus === 'success'`). Consumed as
  // restore-preparation materialization evidence only while the device is
  // observed off — see `ExecutableSteppedStepState.confirmedCommandStepId`.
  confirmedCommandStepId?: string;
};

export type ExecutableSteppedLoadDevice = {
  id: string;
  name: string;
  steppedLoadProfile: SteppedLoadProfile;
  communicationModel?: 'local' | 'cloud';
  controlAdapter?: DeviceControlAdapterSnapshot;
  /** This cycle's shed end state — see `ExecutableShedTarget`. */
  plannedShedTarget?: ExecutableShedTarget;
  current: ExecutableSteppedLoadCurrentState;
  desired: ExecutableSteppedLoadDesiredState;
  previousStepId?: string;
  transition: ExecutableSteppedLoadTransition | null;
  stepActuation: SteppedStepActuationState;
  commandStepActuation: SteppedStepActuationState;
  matchingRestoreAttempt: ExecutableSteppedLoadRestoreAttempt;
  matchingCommandAttempt: ExecutableSteppedLoadRestoreAttempt;
  stepNeedsAdjustment: boolean;
  stepCommandRetryCount: number;
  nextStepCommandRetryAtMs?: number;
  initializationStepId?: string;
};

export type ExecutableSteppedLoadCommandSession = {
  initializationAssumedStepId?: string;
  hasPriorStepCommand: boolean;
  reportedStepId?: string;
};
