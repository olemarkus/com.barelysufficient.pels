import type { AppContext } from '../../lib/app/appContext';
import { createObjectivePriceHorizonBuilder } from './objectivePriceHorizon';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives';
import {
  DeferredObjectiveLifecycleEmitter,
} from '../../lib/objectives/deferredObjectives/lifecycleEmitter';
import {
  migrateBlobToPerKeyIfNeeded,
  readAllObjectives,
} from '../../lib/objectives/deferredObjectives';
import {
  applyShedBehavior,
  type ShedActuationCommand,
  type ShedActuationObservedState,
} from '../../lib/actuator/terminalShedActuation';
import { getLogger } from '../../lib/logging/logger';
import {
  getPrimaryTargetCapability,
  normalizeTargetCapabilityValue,
} from '../../lib/utils/targetCapabilities';
import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadOffStep,
  getSteppedLoadStep,
} from '../../lib/utils/deviceControlProfiles';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import { buildDeviceActuator } from './buildDeviceActuator';
import {
  disableDeferredObjectiveInSettings,
  requireDeferredObjectiveActivePlanRecorder,
  requireDeferredObjectivePlanHistoryRecorder,
  WATERMARK_IDLE_REFRESH_MS,
  writeWatermark,
} from './deferredRecorders';

const terminalReleaseLogger = getLogger('app/deferred-terminal-release');

// Resolve the device's configured fallback posture into a flat shed command.
// EV tasks pause the charger; everything else uses the device's `getShedBehavior`
// (set_temperature → shed setpoint; turn_off / set_step → binary off via the
// device's control capability, or a stepped command when no binary handle exists).
// `flowBackedCapabilityIds` (from the snapshot) marks a binary capability that
// must be driven via its Homey Flow trigger rather than a direct capability write.
export const resolveTerminalShedCommand = (
  device: PlanInputDevice,
  objectiveKind: DeferredObjectiveDiagnostic['objectiveKind'],
  behavior: {
    action: 'turn_off' | 'set_temperature' | 'set_step';
    temperature: number | null;
    stepId?: string | null;
  },
  flowBackedCapabilityIds: readonly string[],
): ShedActuationCommand => {
  if (objectiveKind === 'ev_soc') {
    return {
      kind: 'binary_off',
      capabilityId: 'evcharger_charging',
      flowBacked: flowBackedCapabilityIds.includes('evcharger_charging'),
    };
  }
  // Only emit a `set_temperature` command when the device actually HAS a primary
  // target capability to write to — keyed on the capability's PRESENCE, not its
  // current value. A present capability whose value is transiently unreadable is
  // the self-healing case we must preserve: the actuation
  // (`terminalShedActuation.ts`) no-ops while `observed.targetValue` is non-numeric
  // and the disarm grace keeps the task enabled, so the setpoint is applied as soon
  // as a trusted observation arrives. Falling through to a binary handle (or `skip`)
  // there would drop the diagnostic before the value returns and the configured
  // setpoint shed would never run.
  //
  // The genuine failure this guards against is a MISSING capability: when the
  // behavior says `set_temperature` but the device has NO primary target (stale
  // persisted behavior, or the thermostat/target capability dropped out of the
  // snapshot entirely), the command target would be a real number while the
  // observed value stayed `null` FOREVER — the actuation would no-op every tick,
  // `isInShedPosture` (`null === number`) would never settle, and the task would
  // re-actuate a no-op until the disarm grace elapsed, disarming with the device
  // STILL RUNNING. In that case fall through to the binary-off fallback below,
  // which can still shed the load via the device's binary handle.
  const primaryTarget = getPrimaryTargetCapability(device.targets);
  if (behavior.action === 'set_temperature' && behavior.temperature !== null && primaryTarget !== null) {
    // Normalize the shed setpoint to the target capability's min/max/step the SAME
    // way the transport write does, so the observed (post-write, device-normalized)
    // value matches the command target and `isInShedPosture` actually settles —
    // otherwise an out-of-range legacy setpoint would re-issue every tick until grace.
    return {
      kind: 'set_temperature',
      targetValue: normalizeTargetCapabilityValue({ target: primaryTarget, value: behavior.temperature }),
    };
  }
  const capabilityId = device.controlCapabilityId;
  if (capabilityId) {
    return { kind: 'binary_off', capabilityId, flowBacked: flowBackedCapabilityIds.includes(capabilityId) };
  }
  const stepped = resolveTerminalSteppedShedCommand(device, behavior);
  if (stepped) return stepped;
  return { kind: 'skip', reasonCode: 'no_binary_handle_for_terminal_release' };
};

const resolveTerminalSteppedShedCommand = (
  device: PlanInputDevice,
  behavior: { stepId?: string | null },
): ShedActuationCommand | null => {
  const profile = isSteppedLoadDevice(device) ? device.steppedLoadProfile : null;
  if (!profile) return null;
  const preferred = behavior.stepId ? getSteppedLoadStep(profile, behavior.stepId) : null;
  const target = preferred ?? getSteppedLoadLowestActiveStep(profile) ?? getSteppedLoadOffStep(profile);
  if (!target) return null;
  return {
    kind: 'set_step',
    profile,
    targetStepId: target.id,
    planningCurrentA: resolvePlanningCurrentA(device, target.planningPowerW),
    previousStepId: resolveTrustedStepId(device) ?? device.selectedStepId ?? device.previousStepId,
    stepCommandPending: device.stepCommandPending,
    nextStepCommandRetryAtMs: device.nextStepCommandRetryAtMs,
  };
};

const resolvePlanningCurrentA = (device: PlanInputDevice, planningPowerW: number): number => {
  if (device.targetPowerConfig?.enabled === false) return 0;
  if (device.targetPowerConfig?.preset === 'ev_charger_1_phase') return planningPowerW / 230;
  if (device.targetPowerConfig?.preset === 'ev_charger_3_phase') return planningPowerW / (230 * 3);
  return 0;
};

// The terminal-shed primitive routes its writes through the shared device
// actuator (`buildDeviceActuator`), same as the plan executor. Kept as a named
// re-export so the lifecycle + its tests have a single import site.
export const buildShedActuator = (ctx: AppContext): Actuator | null => buildDeviceActuator(ctx);

// Disarm grace: keep re-attempting the terminal release for this long after the
// deadline (the diagnostic survives because the task stays enabled) before giving
// up and disarming anyway, so a device that never reports the shed posture (broken
// observation) cannot keep the task enabled forever. ~5 min ≈ 10 ticks at the 30 s
// lifecycle cadence — generous against slow snapshot refresh, bounded against drift.
const TERMINAL_RELEASE_DISARM_GRACE_MS = 5 * 60 * 1000;

// Binary on/off for the terminal release, read directly from the
// producer-resolved `binaryControl.on` bit for EVERY device kind, EV chargers
// included. `binaryControl.on` IS the trusted binary read: the producer latches
// prior trusted evidence on a missing/transient control read, and when it can
// only synthesize an untrusted value it surfaces that as `available === false`
// (`managerParsedAvailability.resolveAvailable`) — a commandability fact handled
// at the actuation decision in `handleDeferredDeadlineReached`, NOT a state-read
// concern. So this is a 2-state read with no observation-trust / staleness gate:
// re-deriving trust here would reinvent the `binaryControlObservation` coupling
// the producer already owns. (`binaryControl.on === true` for EV iff
// `plugged_in_charging`, per `resolveEvCurrentOn` — a paused charger is off.)
const resolveTerminalBinaryState = (device: PlanInputDevice): 'on' | 'off' => (
  (device.binaryControl?.on ?? true) ? 'on' : 'off'
);

export const readTerminalObserved = (
  device: PlanInputDevice,
): ShedActuationObservedState => {
  // Resolved uniformly for every device kind (EV included). An EV charger has no
  // primary target capability and no stepped-load profile, so `targetValue` and
  // `stepId` resolve to `null`/`undefined` exactly as the old `ev_soc` branch
  // hardcoded — only its binary on/off mattered, and that now comes from the
  // same `binaryControl.on`-backed gate as binary/setpoint devices. The objective
  // kind is no longer consulted here; the EV-specific shed COMMAND (binary-off via
  // `evcharger_charging`) still keys on it in `resolveTerminalShedCommand`.
  //
  // Bind the observed setpoint read to the SAME target cap `resolveTerminalShedCommand`
  // resolves and `applyDeviceTargets` writes, so the idempotency check can't desync
  // from the write. A missing primary target yields `null` here, which is exactly why
  // the command resolver refuses to emit a `set_temperature` command without one.
  const primaryTarget = getPrimaryTargetCapability(device.targets);
  return {
    binaryState: resolveTerminalBinaryState(device),
    targetValue: typeof primaryTarget?.value === 'number' ? primaryTarget.value : null,
    stepId: resolveTrustedStepId(device),
  };
};

// Only the reported step is trusted telemetry; the producer populates
// `reportedStepId` exclusively from native/flow reports, so it is exactly the
// previous `actualStepSource === 'reported'` step.
const resolveTrustedStepId = (device: PlanInputDevice): string | undefined => (
  device.reportedStepId
);

const isAtOrBelowStep = (
  command: Extract<ShedActuationCommand, { kind: 'set_step' }>,
  stepId: string,
): boolean => {
  const target = getSteppedLoadStep(command.profile, command.targetStepId);
  const observed = getSteppedLoadStep(command.profile, stepId);
  if (!target || !observed) return false;
  return observed.planningPowerW <= target.planningPowerW;
};

// True when the device is already in the command's shed posture (off, or at the
// shed setpoint) — i.e. nothing left to actuate, safe to disarm.
const isInShedPosture = (command: ShedActuationCommand, observed: ShedActuationObservedState): boolean => {
  if (command.kind === 'binary_off') return observed.binaryState === 'off';
  if (command.kind === 'set_temperature') return observed.targetValue === command.targetValue;
  if (command.kind === 'set_step') return observed.stepId ? isAtOrBelowStep(command, observed.stepId) : false;
  return true; // skip: nothing to actuate
};

/**
 * The gated-ending decision (the P1 fix made pure + testable). Disarm the task
 * only once the release is SETTLED (device already in the shed posture, or the
 * command is a skip) OR the grace window has elapsed; otherwise actuate and keep
 * the task enabled so the diagnostic survives and the release re-fires next tick.
 * This is what prevents the release being a single shot that a transient
 * `unknown` observation or a dropped write could miss.
 */
export const planTerminalEnding = (
  command: ShedActuationCommand,
  observed: ShedActuationObservedState,
  graceElapsed: boolean,
): { actuate: boolean; disarm: boolean } => {
  if (isInShedPosture(command, observed)) return { actuate: false, disarm: true };
  return { actuate: true, disarm: graceElapsed };
};

// Clock-driven END of a task: return the cap-off device it was driving to its
// configured fallback posture directly via the transport, AND disarm the task —
// but disarm only once the release is SETTLED (device observed in the shed
// posture) or the grace window has elapsed. Keeping the task enabled while the
// release is still pending means this diagnostic survives the next tick and the
// release re-fires, so a transient `unknown` observation (e.g. right after a
// Homey restart) or a single dropped write self-heals instead of leaving the
// device running. Only cap-off (`isCapacityControlEnabled === false`) devices are
// actuated — the planner owns cap-on devices on its normal lane.
export const handleDeferredDeadlineReached = (
  ctx: AppContext,
  deviceId: string,
  objectiveKind: DeferredObjectiveDiagnostic['objectiveKind'],
  deadlineAtMs: number,
  nowMs: number,
): void => {
  const disarm = () => disableDeferredObjectiveInSettings(ctx, deviceId);
  const graceElapsed = nowMs - deadlineAtMs >= TERMINAL_RELEASE_DISARM_GRACE_MS;
  // Cap-on → the planner owns the device on its normal lane; just disarm (no
  // terminal release, no actuation needed, device presence irrelevant).
  if (ctx.isCapacityControlEnabled(deviceId)) { disarm(); return; }
  const actuator = buildShedActuator(ctx);
  const device = ctx.planService?.getPlanDevices().find((candidate) => candidate.id === deviceId);
  if (!actuator || !device) {
    // Cap-off device temporarily absent (startup / snapshot flicker) — the
    // settings-derived diagnostic still fires, but we can't actuate yet.
    // DON'T disarm immediately, or we'd remove the diagnostic before the device
    // reappears and leave it running. Keep the task enabled and re-check next
    // tick; give up (disarm) only after grace. Same self-healing discipline as
    // the unavailable-device gate below.
    if (graceElapsed) disarm();
    return;
  }
  // Commandability gate: `available === false` means the device cannot be driven
  // this tick (offline, or the producer could only synthesize an untrusted
  // control read — `managerParsedAvailability.resolveAvailable`). We can neither
  // actuate nor trust that an apparent-off is settled, so keep the task enabled
  // and retry — same self-healing discipline as the absent-device case above —
  // disarming only after grace. This replaces the old observation-trust
  // `'unknown'` state read: commandability lives here, not in the binary read.
  if (device.available === false) {
    if (graceElapsed) disarm();
    return;
  }
  const snapshot = ctx.latestTargetSnapshot.find((candidate) => candidate.id === deviceId);
  const flowBackedCapabilityIds = snapshot?.flowBackedCapabilityIds ?? [];
  const command = resolveTerminalShedCommand(
    device,
    objectiveKind,
    ctx.getShedBehavior(deviceId),
    flowBackedCapabilityIds,
  );
  const observed = readTerminalObserved(device);
  const { actuate, disarm: shouldDisarm } = planTerminalEnding(command, observed, graceElapsed);
  if (actuate) {
    // Issue the shed command (a no-op inside applyShedBehavior when there is no
    // trusted observation). Fire-and-forget: the tick is synchronous and must not
    // block on a transport write; a dropped write self-heals on the next tick
    // (the task stays enabled until settled or grace).
    void applyShedBehavior({
      deviceId,
      name: device.name,
      command,
      observed,
      actuator,
      markSteppedLoadDesiredStepIssued: (markParams) =>
        ctx.deviceControlHelpers.markSteppedLoadDesiredStepIssued(markParams),
    })
      .catch((error: unknown) => {
        terminalReleaseLogger.warn({ event: 'terminal_release_failed', deviceId, error: String(error) });
      });
  }
  if (shouldDisarm) disarm();
};

/**
 * Constructs the clock-driven smart-task lifecycle emitter. This is the home
 * of the lifecycle EMISSION — the time-based facts (status transitions,
 * hours-remaining crossings, deadline/ended events, plan-history + active-plan
 * recording) that used to run inside `planBuilder` on the power cycle. Moving
 * the wiring here (consumed by `startDeferredObjectiveLifecycleClock`) is the
 * "lift the lifecycle onto its own clock" step — the planner no longer emits
 * or records smart-task state. The `observe*` closures (including the watermark
 * persistence bookkeeping) are moved verbatim from `createPlanEngine`; the
 * emitter owns the `lastWatermarkPersistMs` state via the closure below.
 *
 * INVARIANT: this emitter is the sole WRITER to BOTH the plan-history recorder
 * AND the active-plan commitment recorder (`observeDeferredObjectiveActivePlans`
 * below). The planner/decoration only READS committed plans via
 * `resolveCommittedHours`; reads are free every power cycle, so the writes ride
 * this clock — the recorder gates replan revisions to once per hour at `:58`
 * (a first revision is immediate). The clock also CLEARS an ended task's plan via
 * `onDeadlinePassed → disableDeferredObjectiveInSettings`. Do not reintroduce a
 * second `ConcurrentEligibleTaskTracker` on the decoration side.
 *
 * See notes/state-management/deferred-objective-lifecycle-carveout.md.
 */
export function createDeferredObjectiveLifecycleEmitter(
  ctx: AppContext,
): DeferredObjectiveLifecycleEmitter {
  let lastWatermarkPersistMs = 0;
  return new DeferredObjectiveLifecycleEmitter({
    getDeferredObjectiveSettings: () => {
      // Self-heal a boot-time empty-`getKeys()` flake that skipped the one-shot
      // migration: idempotent + marker-gated (a cheap single `get` once done),
      // so retrying on the clock tick makes legacy objectives visible within
      // seconds instead of staying invisible until the next app restart.
      migrateBlobToPerKeyIfNeeded(ctx.homey.settings);
      return readAllObjectives(ctx.homey.settings);
    },
    getTimeZone: () => ctx.getTimeZone(),
    getDevices: () => ctx.planService?.getPlanDevices() ?? [],
    getPowerTracker: () => ctx.powerTracker,
    getDailyBudgetSnapshot: () => ctx.dailyBudgetService?.getSnapshot() ?? null,
    // Allocation-horizon price source, resolved from the price layer; shared
    // single source of truth (see `createObjectivePriceHorizonBuilder`).
    buildPriceHorizon: createObjectivePriceHorizonBuilder(ctx),
    getPriceOptimizationEnabled: () => ctx.priceOptimizationEnabled,
    getDeferredObjectiveActivePlans: () => (
      ctx.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null
    ),
    getHardCapKw: () => ctx.capacitySettings.limitKw,
    getDeferredObjectiveDebugStructured: () => (
      ctx.getStructuredDebugEmitter('deferred_objectives', 'deferred_objectives')
    ),
    getDeferredObjectiveStatusBus: () => ctx.deferredObjectiveStatusBus,
    getDeferredObjectiveHoursRemainingBus: () => ctx.deferredObjectiveHoursRemainingBus,
    getDeferredObjectiveHoursRemainingTracker: () => ctx.deferredObjectiveHoursRemainingTracker,
    onDeadlineReached: (deviceId, objectiveKind, deadlineAtMs, nowMs) => (
      handleDeferredDeadlineReached(ctx, deviceId, objectiveKind, deadlineAtMs, nowMs)
    ),
    observeDeferredObjectivePlanHistory: (diagnostics, nowMs, activePlans, getStallClassification) => {
      const recorder = requireDeferredObjectivePlanHistoryRecorder(ctx);
      recorder.observe(diagnostics, nowMs, activePlans, getStallClassification);
      // Persist the watermark when we flushed new history (recorder is clean and the save
      // succeeded). Otherwise, if the recorder is clean and enough time has passed since the
      // last watermark write, also advance it — this keeps the back-fill window small during
      // long idle stretches and prevents post-enable objectives from being back-filled into
      // periods they didn't exist for. If the recorder is still dirty (failed save), leave
      // the watermark alone so the next restart re-tries the persistence.
      const flushed = recorder.flushIfDirty();
      if (flushed) {
        writeWatermark(ctx, nowMs);
        lastWatermarkPersistMs = nowMs;
        return;
      }
      if (recorder.isDirty()) return;
      if (nowMs - lastWatermarkPersistMs < WATERMARK_IDLE_REFRESH_MS) return;
      writeWatermark(ctx, nowMs);
      lastWatermarkPersistMs = nowMs;
    },
    // Active-plan commitment WRITE, on the clock. The recorder gates replan
    // revisions to once per hour at :58 (first revision immediate); the planner
    // READS the committed plan every power cycle for its decoration. Driving the
    // write off the reliable 30 s clock means it can never be starved by
    // power-reading timing (the prior power-cycle commit could, in theory).
    observeDeferredObjectiveActivePlans: (diagnostics, nowMs) => {
      const recorder = requireDeferredObjectiveActivePlanRecorder(ctx);
      recorder.observe(diagnostics, nowMs);
      recorder.flushIfDirty();
    },
    getStallClassification: (deviceId) => ctx.planService?.getStallClassification(deviceId),
  });
}
