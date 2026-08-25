import type { AppContext } from '../../lib/app/appContext';
import { resolveConfiguredDevicePriority } from '../../lib/utils/capacityHelpers';
import type { SmartTaskHomeScope } from '../../packages/contracts/src/smartTaskHomeScope';
import { createObjectivePriceHorizonBuilder } from './objectivePriceHorizon';
import {
  resolveSmartTaskDeviceExclusion,
  resolveSmartTaskHomeScope,
} from './smartTaskHomeScope';
import {
  DeferredObjectiveLifecycleEmitter,
} from '../../lib/objectives/deferredObjectives/lifecycleEmitter';
import {
  createTrustedDeferredObjectiveSettingsReader,
} from '../../lib/objectives/deferredObjectives';
import {
  disableDeferredObjectiveInSettings,
  requireDeferredObjectiveActivePlanRecorder,
  requireDeferredObjectivePlanHistoryRecorder,
  runPendingDeferredObjectiveBackfill,
  WATERMARK_IDLE_REFRESH_MS,
  writeWatermark,
} from './deferredRecorders';
import { resolveLifecycleFallbackRequest } from '../lifecycleFallbackRequest';
import { projectLifecycleFallbackCommandState } from '../lifecycleFallbackDeviceProjection';
import { requirePlanService } from './contextGuards';

// Disarm grace: keep re-attempting the terminal release for this long after the
// deadline (the diagnostic survives because the task stays enabled) before giving
// up and disarming anyway, so a device that never reports the shed posture (broken
// observation) cannot keep the task enabled forever. ~5 min ≈ 10 ticks at the 30 s
// lifecycle cadence — generous against slow snapshot refresh, bounded against drift.
const TERMINAL_RELEASE_DISARM_GRACE_MS = 5 * 60 * 1000;

/**
 * The home-scope gate for a deadline tick.
 * Durable scope exclusions (a device relocated to a separate-meter sub-home, or
 * one newly selected as an active meter source) have no terminal command:
 * `disarm` immediately, so a stale task cannot retry forever against a device
 * PELS must not control. A global/provisional Main fence is normally transient
 * (a zone tree that has not committed, a suspect settings read) — `retry` on
 * the next lifecycle tick. But a fence can also persist — a Main whole-home
 * meter that is also a meter area's meter holds it until the owner fixes one of
 * the two selections — and without a grace bail the objective would stay
 * enabled past its deadline forever, never filing the run. Give up after the
 * same grace the absent-device and unavailable-device arms use, with no
 * actuation: the fence exists precisely because a Main write cannot be trusted.
 */
const planScopeGateAction = (
  homeScope: SmartTaskHomeScope,
  graceElapsed: boolean,
): 'disarm' | 'retry' | 'proceed' => {
  if (homeScope === 'sub_home' || homeScope === 'source_device') return 'disarm';
  if (homeScope === 'unavailable') return graceElapsed ? 'disarm' : 'retry';
  return 'proceed';
};

type TerminalFallbackTiming =
  | { kind: 'satisfied' }
  | { kind: 'deadline_reached'; deadlineAtMs: number; nowMs: number };

const resolveTerminalFallbackEnding = (
  ctx: AppContext,
  deviceId: string,
  timing: TerminalFallbackTiming,
): { graceElapsed: boolean; disarm: () => void } => {
  if (timing.kind === 'satisfied') {
    return { graceElapsed: false, disarm: (): void => undefined };
  }
  return {
    graceElapsed: timing.nowMs - timing.deadlineAtMs >= TERMINAL_RELEASE_DISARM_GRACE_MS,
    disarm: () => disableDeferredObjectiveInSettings(ctx, deviceId),
  };
};

const abandonLifecycleFallback = (ctx: AppContext, deviceId: string): void => {
  ctx.lifecycleFallback?.abandon(deviceId);
};

const convergeLifecycleFallback = (
  ctx: AppContext,
  deviceId: string,
): 'settled' | 'pending' | 'unavailable' | 'undriveable' => {
  const commandState = projectLifecycleFallbackCommandState({
    device: ctx.deviceControlHelpers.getLifecycleFallbackDevice(deviceId),
    observedState: ctx.getObservedState(deviceId),
  });
  if (commandState.state === 'unavailable') return 'unavailable';
  // Resolved BEFORE the executor port is required: answering "there is nothing
  // on this device to command" needs no dispatcher, and must not depend on one.
  const resolution = resolveLifecycleFallbackRequest({
    device: commandState.device,
    observedState: commandState.observedState,
    configuredFallback: ctx.getShedBehavior(deviceId),
  });
  if (resolution.state === 'no_writable_axis') {
    // The one thing the old `'unsupported'` arm never did: say so. A device with
    // no commandable axis (a temperature-control-disabled thermostat with no
    // `onoff`) is a real configuration, so it takes the same graced retry as a
    // device PELS cannot observe — never an immediate, silent disarm.
    ctx.getStructuredLogger('deferred_objectives')?.warn({
      event: 'smart_task_fallback_device_undriveable',
      reasonCode: 'no_writable_axis',
      deviceId,
    });
    return 'undriveable';
  }
  const lifecycleFallback = ctx.lifecycleFallback;
  if (!lifecycleFallback) throw new Error('Lifecycle fallback must be initialized before deferred objectives.');
  return lifecycleFallback.converge(resolution.request).settled ? 'settled' : 'pending';
};

const handleDeferredTerminalFallback = (
  ctx: AppContext,
  deviceId: string,
  timing: TerminalFallbackTiming,
): void => {
  const { graceElapsed, disarm } = resolveTerminalFallbackEnding(ctx, deviceId, timing);
  const scopeGate = planScopeGateAction(resolveSmartTaskHomeScope(ctx, deviceId), graceElapsed);
  if (scopeGate === 'disarm') {
    abandonLifecycleFallback(ctx, deviceId);
    disarm();
    return;
  }
  if (scopeGate === 'retry') {
    abandonLifecycleFallback(ctx, deviceId);
    return;
  }
  // "Managed by PELS" is off. The task has been PAUSED all along (its diagnostic
  // reads `objective_device_unmanaged`), and a pause that still writes a
  // terminal command at the deadline is not a pause — it is PELS driving a
  // device the owner took away from it. End it exactly as a relocated device
  // ends: abandon the fallback, disarm, write nothing. This must come before the
  // capacity-control check below, which is ALSO false for an un-managed device
  // and would fall through to `convergeLifecycleFallback` and actuate.
  if (resolveSmartTaskDeviceExclusion(ctx, deviceId) === 'unmanaged') {
    abandonLifecycleFallback(ctx, deviceId);
    disarm();
    return;
  }
  // Cap-on → the planner owns the device on its normal lane. Only the deadline
  // ends the task; early satisfaction must never disable it.
  if (ctx.isCapacityControlEnabled(deviceId)) {
    abandonLifecycleFallback(ctx, deviceId);
    disarm();
    return;
  }
  // Missing and explicitly unavailable observer projections both retry until
  // deadline grace. The app-owned producer resolves that classification before
  // a neutral request crosses into the executor.
  const outcome = convergeLifecycleFallback(ctx, deviceId);
  // A device PELS cannot observe and a device PELS cannot command share one
  // ending: keep retrying, and give up only once the deadline grace has run.
  if (outcome === 'unavailable' || outcome === 'undriveable') {
    abandonLifecycleFallback(ctx, deviceId);
    if (graceElapsed) disarm();
    return;
  }
  if (outcome === 'settled' && timing.kind === 'satisfied') return;
  if (outcome === 'settled' || graceElapsed) {
    abandonLifecycleFallback(ctx, deviceId);
    disarm();
  }
};

// Satisfaction can happen well before the deadline. Return a cap-off device to
// its configured fallback posture on every lifecycle tick until observation
// settles, but keep the task enabled so the deadline remains its sole ending.
export const handleDeferredSatisfied = (
  ctx: AppContext,
  deviceId: string,
): void => handleDeferredTerminalFallback(ctx, deviceId, { kind: 'satisfied' });

// Clock-driven END of a task: return the cap-off device it was driving to its
// configured fallback posture through the executor-owned actuator lane, AND disarm the task —
// but disarm only once the release is settled or the grace window has elapsed.
export const handleDeferredDeadlineReached = (
  ctx: AppContext,
  deviceId: string,
  deadlineAtMs: number,
  nowMs: number,
): void => handleDeferredTerminalFallback(ctx, deviceId, {
  kind: 'deadline_reached',
  deadlineAtMs,
  nowMs,
});

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
 * `onDeadlineReached → disableDeferredObjectiveInSettings`. Do not reintroduce a
 * second active-plan WRITER on the decoration side. Lifecycle and decoration
 * intentionally keep separate `PriorityAllocationTracker` caches because each
 * evaluator owns its own SDK-snapshot grace state.
 *
 * See notes/state-management/deferred-objective-lifecycle-carveout.md.
 */
export function createDeferredObjectiveLifecycleEmitter(
  ctx: AppContext,
): DeferredObjectiveLifecycleEmitter {
  let lastWatermarkPersistMs = 0;
  const readTrustedObjectiveSettings = createTrustedDeferredObjectiveSettingsReader(ctx.homey.settings);
  return new DeferredObjectiveLifecycleEmitter({
    getDeferredObjectiveSettings: () => {
      // Self-heal a boot-time empty-`getKeys()` flake that skipped the one-shot
      // migration: idempotent + marker-gated (a cheap single `get` once done),
      // so retrying on the clock tick makes legacy objectives visible within
      // seconds instead of staying invisible until the next app restart.
      return readTrustedObjectiveSettings();
    },
    getTimeZone: () => ctx.getTimeZone(),
    getDevices: () => requirePlanService(ctx).getPlanDevices(),
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
    getBasePriorityForDevice: (deviceId) => (
      resolveConfiguredDevicePriority(ctx.capacityPriorities, ctx.operatingMode, deviceId)
    ),
    // An excluded task's lifecycle diagnostics carry the dedicated code for
    // their exclusion (relocated → `objective_device_in_sub_home`, unmanaged →
    // `objective_device_unmanaged`), and the eligible-count denominator
    // excludes it (see the dep's doc on the emitter).
    resolveDeviceExclusion: (deviceId) => resolveSmartTaskDeviceExclusion(ctx, deviceId),
    getDeferredObjectiveDebugStructured: () => (
      ctx.getStructuredDebugEmitter('deferred_objectives', 'deferred_objectives')
    ),
    getDeferredObjectiveStatusBus: () => ctx.deferredObjectiveStatusBus,
    getDeferredObjectiveHoursRemainingBus: () => ctx.deferredObjectiveHoursRemainingBus,
    getDeferredObjectiveHoursRemainingTracker: () => ctx.deferredObjectiveHoursRemainingTracker,
    onSatisfied: (deviceId) => (
      handleDeferredSatisfied(ctx, deviceId)
    ),
    onFallbackInactive: (deviceId) => abandonLifecycleFallback(ctx, deviceId),
    onDeadlineReached: (deviceId, deadlineAtMs, nowMs) => (
      handleDeferredDeadlineReached(ctx, deviceId, deadlineAtMs, nowMs)
    ),
    observeDeferredObjectivePlanHistory: (diagnostics, nowMs, activePlans, getStallClassification) => {
      const recorder = requireDeferredObjectivePlanHistoryRecorder(ctx);
      // Run the offline-window back-fill that an earlier boot deferred because the per-key
      // migration marker was still unset (an empty-`getKeys()` flake). `getDeferredObjectiveSettings`
      // above already retried `migrateBlobToPerKeyIfNeeded` on this same tick, so the marker is
      // now set when the retry succeeded — back-fill the pending `(watermark, now]` window HERE,
      // before the watermark-advance below jumps it to `now` and silently skips the migrated
      // legacy task's elapsed deadline. No-op once back-fill completed for this session.
      runPendingDeferredObjectiveBackfill(ctx, recorder);
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
      // A still-pending back-fill (a boot flake deferred the migration and this tick's retry
      // didn't complete it — e.g. getKeys() flaked empty again) means the (watermark, now]
      // offline window is still owed. The idle-refresh advance must NOT jump the watermark
      // past it, or the owed window is permanently skipped — the same silent-history-loss the
      // back-fill path itself guards against. Leave the watermark; a later healthy tick
      // completes the back-fill and advances it then.
      if (ctx.deferredObjectiveBackfillPending) return;
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
    getStallClassification: (deviceId) => requirePlanService(ctx).getStallEvidence(deviceId),
  });
}
