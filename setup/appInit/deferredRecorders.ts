import { createCurrentTaskEvaluationReader } from '../../lib/objectives/deferredObjectives/currentTaskEvaluation';
import {
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
  normalizeDeferredObjectivePlanHistory,
  objectiveKeyListIsTrustworthy,
  readAllObjectives,
  readObjectiveForDevice,
  writeObjectiveForDevice,
  type DeferredObjectiveBackfillConfig,
  type DeferredObjectiveDeviceWriteDeps,
} from '../../lib/objectives/deferredObjectives';
import type { DeferredObjectiveSettingsEntry } from '../../packages/contracts/src/deferredObjectiveSettings';
import { DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK } from '../../lib/utils/settingsKeys';
import { resolveSmartTaskHomeScope } from './smartTaskHomeScope';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import { resolveObjectiveTargetValue } from '../../packages/shared-domain/src/deferredObjectiveValues';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { AppContext } from '../../lib/app/appContext';
import { createPlanHistoryStoreForApp } from './planHistoryStore';
import { requireDeviceManager, requirePlanService, requirePriceCoordinator } from './contextGuards';
import { EnergyTaskDeliveryTracker } from '../../lib/objectives/deferredObjectives/energyDelivery';
import { createEnergyDeliveryStore } from '../../lib/objectives/deferredObjectives/energyDeliveryStore';
import {
  createActivePlanPersistence,
  createActivePlanStore,
  importLegacyActivePlans,
} from '../../lib/objectives/deferredObjectives/activePlanStore';
import { assembleActivePlansUiView } from '../../lib/objectives/deferredObjectives/activePlansUiView';
import { emitDeferredObjectiveActivePlansUpdatedForApp } from '../settingsUiAppRuntime';

// How long the deferred-objective observation watermark can be stale before we advance it
// during normal observe ticks. Without this idle advance the watermark only moves forward
// when a deadline finalizes — so a user enabling a new objective during a long quiet period
// followed by a crash would cause startup back-fill to enumerate that objective's deadlines
// back to a far-stale watermark, fabricating "unknown" entries for periods when the objective
// wasn't yet enabled. Five minutes keeps watermark drift small without spamming settings I/O.
export const WATERMARK_IDLE_REFRESH_MS = 5 * 60 * 1000;

const toBackfillConfig = (
  deviceId: string,
  entry: DeferredObjectiveSettingsEntry,
): DeferredObjectiveBackfillConfig | null => {
  // Deadlines are one-shot and the runtime auto-disables on pass, so a still-enabled
  // objective with a past `deadlineAtMs` is exactly the "PELS was off through the deadline"
  // case we want to back-fill. Disabled entries either have an existing observed history row
  // (runtime saw the pass) or were cleared by the user before passing — either way back-fill
  // should ignore them.
  if (!entry.enabled) return null;
  return {
    deviceId,
    deadlineAtMs: entry.deadlineAtMs,
    targetValue: resolveObjectiveTargetValue(entry),
  };
};

const readWatermark = (ctx: AppContext): number | null => {
  const raw: unknown = ctx.homey.settings.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK);
  return isFiniteNumber(raw) ? raw : null;
};

/**
 * Advance the deferred-objective observation watermark to "now". The watermark is left
 * alone (not advanced) in two cases, both of which would otherwise drop history silently:
 *
 *  - The recorder is still dirty (its `save` callback returned `false`, meaning the last
 *    flush attempt didn't actually persist) — advancing would skip the window containing
 *    the entries that never made it to disk.
 *  - A startup back-fill is still PENDING (`ctx.deferredObjectiveBackfillPending`). This
 *    happens when a boot-time `getKeys()` flake deferred it and the
 *    first lifecycle tick (~30s out) hasn't yet run the pending back-fill. If the app
 *    restarts in that window the in-memory latch is lost; advancing the watermark on
 *    uninit would make the next boot's startup back-fill skip the still-owed offline
 *    window forever. Leaving the watermark in place lets the next boot re-scan it.
 */
export const persistDeferredObjectiveObservationWatermark = (
  ctx: AppContext,
  recorder: DeferredObjectivePlanHistoryRecorder | undefined,
): void => {
  if (recorder?.isDirty()) return;
  if (ctx.deferredObjectiveBackfillPending) return;
  writeWatermark(ctx, Date.now());
};

// Latch (or clear) the "startup back-fill still pending" flag on the shared context. A
// single helper so the one ctx-mutation lint exception lives in exactly one place rather
// than scattered across every call site.
const setBackfillPending = (ctx: AppContext, pending: boolean): void => {
  // eslint-disable-next-line functional/immutable-data, no-param-reassign
  ctx.deferredObjectiveBackfillPending = pending;
};

export const writeWatermark = (ctx: AppContext, ms: number): void => {
  try {
    ctx.homey.settings.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, ms);
  } catch (error) {
    ctx.getStructuredLogger('deferred_objectives').error({
      event: 'deferred_objective_observation_watermark_persist_failed',
      err: normalizeError(error),
    });
  }
};

export function createDeferredObjectivePlanHistoryRecorder(
  ctx: AppContext,
): DeferredObjectivePlanHistoryRecorder {
  const store = createPlanHistoryStoreForApp(ctx);
  let loadUnavailable = false;
  const recorder = new DeferredObjectivePlanHistoryRecorder({
    // The store either answers or throws (I/O). A throw keeps the recorder's
    // persistence closed until a later load succeeds, so an empty in-memory
    // history can never be written over one the process failed to read.
    load: () => {
      let snapshot: ReturnType<typeof normalizeDeferredObjectivePlanHistory>;
      let meteredDeliveryStates: ReturnType<typeof store.readMeteredDelivery>;
      try {
        snapshot = store.read() ?? normalizeDeferredObjectivePlanHistory(null);
        meteredDeliveryStates = store.readMeteredDelivery();
      } catch (error) {
        if (!loadUnavailable) {
          loadUnavailable = true;
          ctx.getStructuredLogger('deferred_objectives').warn({
            event: 'deferred_objective_plan_history_load_unavailable', err: normalizeError(error),
          });
        }
        return {
          snapshot: normalizeDeferredObjectivePlanHistory(null),
          persistenceSafe: false,
          meteredDeliveryStates: [],
        };
      }
      if (loadUnavailable) {
        loadUnavailable = false;
        ctx.getStructuredLogger('deferred_objectives').info({
          event: 'deferred_objective_plan_history_load_recovered',
        });
      }
      return { snapshot, persistenceSafe: true, meteredDeliveryStates };
    },
    save: (next, meteredDeliveryStates) => {
      try {
        store.write(next);
        store.writeMeteredDelivery(meteredDeliveryStates);
        return true;
      } catch (error) {
        ctx.getStructuredLogger('deferred_objectives').error({
          event: 'deferred_objective_plan_history_persist_failed',
          err: normalizeError(error),
        });
        return false;
      }
    },
    endedBus: ctx.deferredObjectiveEndedBus,
    getMeteredPricePeriods: (startMs, endMs) => requirePriceCoordinator(ctx).getMeteredPricePeriods(startMs, endMs),
    // Read lazily on the lifecycle clock, after the plan service exists.
    getStallClassification: (deviceId) => requirePlanService(ctx).getStallEvidence(deviceId),
    getDeviceConstraint: (deviceId) => requireDeviceManager(ctx).getTaskDeliveryConstraint(deviceId),
    getDeliveryControl: (deviceId) => requirePlanService(ctx).getTaskDeliveryControl(deviceId),
    isLiveMeasuredDraw: (deviceId) => ctx.observer.isLiveMeasuredDraw(deviceId),
  });
  runStartupBackfill(ctx, recorder);
  return recorder;
}

function runStartupBackfill(
  ctx: AppContext,
  recorder: DeferredObjectivePlanHistoryRecorder,
): void {
  const watermark = readWatermark(ctx);
  if (watermark === null) {
    // First boot with this version (or the setting was lost). Seed the watermark to now so a
    // future crash/restart can back-fill from this moment forward — otherwise a deadline that
    // elapses during a PELS-off window before the first history flush would be lost. We
    // intentionally don't back-fill on this path: there's no prior observation window, and
    // inventing one (e.g. 30 days back) could fabricate "unknown" entries for objectives the
    // user only just configured.
    writeWatermark(ctx, Date.now());
    return;
  }
  attemptDeferredObjectiveBackfill(ctx, recorder, watermark);
}

/**
 * Run the offline-window back-fill for the `(watermark, now]` window.
 *
 * Returns `'deferred'` when the key list is untrustworthy (latching
 * `ctx.deferredObjectiveBackfillPending`) or the back-filled entries did not persist (the
 * dirty recorder keeps them for a later flush): advancing the watermark then would
 * PERMANENTLY skip the back-fill window for tasks that ARE persisted. The watermark is left
 * untouched so a later attempt back-fills the full window before any tick advances the
 * watermark past it.
 *
 * Returns `'completed'` once the back-fill has run (watermark advanced on a successful
 * persist) and clears the latch, so it runs AT MOST once per session after a deferral
 * rather than re-scanning every tick.
 */
function attemptDeferredObjectiveBackfill(
  ctx: AppContext,
  recorder: DeferredObjectivePlanHistoryRecorder,
  watermark: number,
): 'completed' | 'deferred' {
  const log = ctx.getStructuredLogger('deferred_objectives');
  // `readAllObjectives` returns an empty map on a transient-empty key list by design (see
  // objectiveStore.readAllObjectives). An empty result is therefore ambiguous: it is either a
  // genuine zero-enabled-objectives store OR a flaky read. Only the trustworthy (non-empty)
  // key-list case may advance the watermark / clear the latch. On a flaky empty read, leave
  // both untouched and retry next tick — otherwise the `configs.length === 0` branch below
  // would PERMANENTLY skip the offline window (the exact silent-history-loss this guards).
  // Mirrors the abandon-grace shape of objectiveAbsenceIsTrustworthy, and
  // `runPendingDeferredObjectiveBackfill`'s null-watermark grace, which also refuses to
  // clear the latch on an untrustworthy read.
  if (!objectiveKeyListIsTrustworthy(ctx.homey.settings)) {
    setBackfillPending(ctx, true);
    log.info({ event: 'deferred_objective_backfill_deferred', reason: 'key_list_untrustworthy' });
    return 'deferred';
  }
  const settings = readAllObjectives(ctx.homey.settings);
  const configs = Object.entries(settings.objectivesByDeviceId)
    .map(([deviceId, entry]) => toBackfillConfig(deviceId, entry))
    .filter((c): c is DeferredObjectiveBackfillConfig => c !== null);
  const nowMs = Date.now();
  if (configs.length === 0) {
    // No enabled objectives in a CONFIRMED non-empty key list — advance the watermark anyway.
    // We successfully scanned a window that produced nothing, and on the next restart we don't
    // need to re-scan it.
    // Caveat: a future "enable an objective" action can't retroactively recover deadlines
    // that elapsed inside this skipped window — that fidelity gap is acknowledged in
    // PR-description and would need per-objective enable timestamps to fix.
    writeWatermark(ctx, nowMs);
    setBackfillPending(ctx, false);
    log.info({
      event: 'deferred_objective_backfill_watermark_advanced',
      reason: 'no_enabled_objectives',
      windowStartMs: watermark,
      windowEndMs: nowMs,
    });
    return 'completed';
  }
  const entriesBefore = recorder.getHistorySnapshot().entries.length;
  recorder.backfillFromConfig(configs, watermark, nowMs);
  if (recorder.isDirty()) {
    // Back-fill produced new entries — only advance the watermark if we actually persisted
    // them. A failed save keeps the entries in memory for a later retry; leaving the
    // watermark in place means the next attempt re-runs the scan idempotently. Keep the
    // latch set so the next tick retries the persistence instead of advancing the watermark.
    if (!recorder.flushIfDirty()) {
      log.info({ event: 'deferred_objective_backfill_deferred', reason: 'persist_failed' });
      return 'deferred';
    }
  }
  writeWatermark(ctx, nowMs);
  setBackfillPending(ctx, false);
  log.info({
    event: 'deferred_objective_backfill_completed',
    addedEntryCount: Math.max(0, recorder.getHistorySnapshot().entries.length - entriesBefore),
    windowStartMs: watermark,
    windowEndMs: nowMs,
  });
  return 'completed';
}

/**
 * Run the back-fill that an earlier attempt deferred (`ctx.deferredObjectiveBackfillPending`).
 * Invoked at the TOP of each observe tick, BEFORE the tick advances the watermark — so the
 * still-pending `(watermark, now]` offline window is back-filled before the watermark jumps
 * to `now` and an elapsed deadline in it is silently skipped. No-op (and no re-scan) once
 * the back-fill has completed for this session.
 */
export function runPendingDeferredObjectiveBackfill(
  ctx: AppContext,
  recorder: DeferredObjectivePlanHistoryRecorder,
): void {
  if (!ctx.deferredObjectiveBackfillPending) return;
  const watermark = readWatermark(ctx);
  if (watermark === null) {
    // The latch was only set because `runStartupBackfill` read a non-null watermark at boot,
    // so a null read here is a transient Homey-settings flake (per feedback_homey_sdk_unreliable).
    // Leave the latch SET and retry on a later tick rather than abandoning the still-pending
    // offline window — clearing it would permanently skip the back-fill this session.
    return;
  }
  attemptDeferredObjectiveBackfill(ctx, recorder, watermark);
}

/**
 * The energy-task delivery counter on the app's userdata database. Its rows are
 * live task state, not history, but they change on every tick an energy task
 * draws, which is exactly the write rate `homey.settings` must never see.
 */
export function createDeferredObjectiveEnergyDelivery(ctx: AppContext): EnergyTaskDeliveryTracker {
  return new EnergyTaskDeliveryTracker(
    createEnergyDeliveryStore(ctx.getUserdataDatabase()),
    (deviceId) => ctx.observer.isLiveMeasuredDraw(deviceId),
  );
}

/** Persist whatever the smart-task stores hold unwritten, before shutdown. */
export function flushDeferredObjectiveRecorders(ctx: AppContext): void {
  ctx.deferredObjectivePlanHistoryRecorder?.flushIfDirty();
  ctx.deferredObjectiveActivePlanRecorder?.flushIfDirty();
  ctx.deferredObjectiveEnergyDelivery?.flushIfDirty();
}

export function requireDeferredObjectiveEnergyDelivery(
  ctx: Pick<AppContext, 'deferredObjectiveEnergyDelivery'>,
): EnergyTaskDeliveryTracker {
  if (!ctx.deferredObjectiveEnergyDelivery) {
    throw new Error('EnergyTaskDeliveryTracker must be initialized before plan engine setup.');
  }
  return ctx.deferredObjectiveEnergyDelivery;
}

export function requireDeferredObjectivePlanHistoryRecorder(
  ctx: AppContext,
): DeferredObjectivePlanHistoryRecorder {
  if (!ctx.deferredObjectivePlanHistoryRecorder) {
    throw new Error('DeferredObjectivePlanHistoryRecorder must be initialized before plan engine setup.');
  }
  return ctx.deferredObjectivePlanHistoryRecorder;
}

export function createDeferredObjectiveActivePlanRecorder(
  ctx: AppContext,
): DeferredObjectiveActivePlanRecorder {
  const store = createActivePlanStore(ctx.getUserdataDatabase());
  importLegacyActivePlans(ctx.homey.settings, store);
  return new DeferredObjectiveActivePlanRecorder({
    ...createActivePlanPersistence(store, (plans) => emitDeferredObjectiveActivePlansUpdatedForApp(
      ctx.homey,
      // The view the bootstrap serves (`AppSmartTaskPayloads`), so the
      // WebView applies a push exactly as it applies the bootstrap.
      assembleActivePlansUiView(
        plans,
        ctx.deferredObjectivePlanHistoryRecorder,
        requireDeferredObjectiveEnergyDelivery(ctx).getDeliveredKWh,
      ),
      (message, error) => ctx.error(message, error),
    )),
    onRevisionWritten: (event) => ctx.deferredObjectivePlanRevisionBus.publish(event),
  });
}

export function requireDeferredObjectiveActivePlanRecorder(
  ctx: AppContext,
): DeferredObjectiveActivePlanRecorder {
  if (!ctx.deferredObjectiveActivePlanRecorder) {
    throw new Error('DeferredObjectiveActivePlanRecorder must be initialized before plan engine setup.');
  }
  return ctx.deferredObjectiveActivePlanRecorder;
}

/**
 * Build the shared device-scoped write deps for the per-device-key objective
 * write ops. Both the create-smart-task widget path (app.ts) and the deadline
 * Flow cards (via appInit) route their settings writes through ops built on
 * this. Each op touches only the target device's own settings key, so there is
 * no shared-map read-modify-write to clobber a sibling — the store is
 * `homey.settings` directly (it structurally satisfies `ObjectiveSettingsStore`).
 */
export const buildDeferredObjectiveDeviceWriteDeps = (
  ctx: AppContext,
  nowMs: number,
): DeferredObjectiveDeviceWriteDeps => {
  const activePlanRecorder = requireDeferredObjectiveActivePlanRecorder(ctx);
  const planHistoryRecorder = requireDeferredObjectivePlanHistoryRecorder(ctx);
  return {
    store: ctx.homey.settings,
    activePlanRecorder,
    planHistoryRecorder,
    nowMs,
    readCurrentTaskEvaluation: createCurrentTaskEvaluationReader({
      getDevices: () => requirePlanService(ctx).getPlanDevices(),
      getThermalDirection: (deviceId) => ctx.observer.getThermalDirection(deviceId),
      getDeliveredEnergyKWh: requireDeferredObjectiveEnergyDelivery(ctx).getDeliveredKWh,
      getStallClassification: (deviceId) => requirePlanService(ctx).getStallEvidence(deviceId),
      hasObservedTask: (deviceId, objective) => planHistoryRecorder.hasObservedTask(deviceId, objective),
    }),
    // Multi-home v1 scope gate: durable relocation is a hard
    // `device_in_sub_home` refusal, while a provisional/global ownership fence
    // is the retryable `ownership_unavailable` lane. Every write surface builds
    // its deps here, so no caller can accidentally collapse the two states.
    resolveDeviceHomeScope: (deviceId) => resolveSmartTaskHomeScope(ctx, deviceId),
  };
};

export const disableDeferredObjectiveInSettings = (ctx: AppContext, deviceId: string): void => {
  // Per-device key: read THIS device's entry, flip its `enabled` flag, and
  // write it back under its own key. A transient-empty read of this one key
  // can never drop a SIBLING device's objective (each lives under its own key),
  // so there is no clobber risk and no refusal branch.
  const entry = readObjectiveForDevice(ctx.homey.settings, deviceId);
  if (!entry || !entry.enabled) return;
  writeObjectiveForDevice(ctx.homey.settings, deviceId, { ...entry, enabled: false });
  // Run the in-memory cleanup now that the disable persisted.
  // Drop in-memory status + active plan so flow conditions like
  // `deadline_status_is` and the deadline UI agree with the persisted state
  // immediately, instead of seeing the last published snapshot until the
  // next plan cycle's forget-sweep runs.
  ctx.deferredObjectiveStatusBus.forgetDevice(deviceId);
  // Re-arm the hours-remaining crossing latch so a later re-enabled task with
  // the same deadline still fires its lead-time trigger rather than treating
  // the stale boundary as already crossed.
  ctx.deferredObjectiveHoursRemainingTracker.forgetDevice(deviceId);
  ctx.deferredObjectiveActivePlanRecorder?.clearForDevice(deviceId);
};
