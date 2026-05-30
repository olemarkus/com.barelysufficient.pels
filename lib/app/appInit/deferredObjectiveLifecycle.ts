import type { AppContext } from '../appContext';
import {
  DeferredObjectiveLifecycleEmitter,
} from '../../objectives/deferredObjectives/lifecycleEmitter';
import {
  migrateBlobToPerKeyIfNeeded,
  readAllObjectives,
} from '../../objectives/deferredObjectives';
import {
  disableDeferredObjectiveInSettings,
  requireDeferredObjectivePlanHistoryRecorder,
  WATERMARK_IDLE_REFRESH_MS,
  writeWatermark,
} from './deferredRecorders';

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
 * INVARIANT: after PR-C this emitter is the sole writer to the plan-history
 * recorder (`planBuilder` no longer records history). The active-plan recorder
 * stays committed synchronously by `planBuilder` (the planner reads committed
 * plans via `resolveCommittedHours` for its decoration); the clock only CLEARS
 * an ended task's plan via `onDeadlinePassed → disableDeferredObjectiveInSettings`
 * (phase-separated from planBuilder's commit). PR-D's decoration relocation must
 * keep the active-plan commitment synchronous and not introduce a third
 * `ConcurrentEligibleTaskTracker`.
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
    disableDeferredObjective: (deviceId) => disableDeferredObjectiveInSettings(ctx, deviceId),
    observeDeferredObjectivePlanHistory: (diagnostics, nowMs, getStallClassification) => {
      const recorder = requireDeferredObjectivePlanHistoryRecorder(ctx);
      const activePlans = ctx.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null;
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
    getStallClassification: (deviceId) => ctx.planService?.getStallClassification(deviceId),
  });
}
