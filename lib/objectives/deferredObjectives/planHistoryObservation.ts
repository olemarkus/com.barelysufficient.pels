import type { DeferredObjectivePlanHistoryRecorder } from './planHistory';
import type { DeferredObjectiveLifecycleEmitterDeps } from './lifecycleEmitter';

// Bound crash-recovery watermark drift without writing settings on every delivery tick.
export const WATERMARK_IDLE_REFRESH_MS = 5 * 60 * 1000;

/** The history owner flushes before advancing its crash-recovery watermark. */
export function createPlanHistoryObservation(
  getRecorder: () => DeferredObjectivePlanHistoryRecorder,
  writeWatermark: (nowMs: number) => void,
): DeferredObjectiveLifecycleEmitterDeps['observeDeferredObjectivePlanHistory'] {
  let lastWatermarkPersistMs = 0;
  return (diagnostics, nowMs, activePlans) => {
    const recorder = getRecorder();
    recorder.observe(diagnostics, nowMs, activePlans);
    // Advance the watermark only once the recorder is clean: a failed save leaves it
    // dirty, and the watermark stays put so the next restart re-tries the persistence.
    // Otherwise advance it on its own throttle — never per flush. An open run's
    // metered delivery accrues on every tick, and a settings write per tick is the
    // allocation churn `settings.set` must never see. A watermark up to one throttle
    // behind costs nothing: back-fill skips any deadline that already has an entry.
    recorder.flushIfDirty();
    if (recorder.isDirty()) return;
    if (nowMs - lastWatermarkPersistMs < WATERMARK_IDLE_REFRESH_MS) return;
    writeWatermark(nowMs);
    lastWatermarkPersistMs = nowMs;
  };
}
