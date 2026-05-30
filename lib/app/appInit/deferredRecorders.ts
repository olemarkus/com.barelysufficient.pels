import { flattenAllHours, readPriceStore } from '../../price/priceStore';
import {
  resolvePostmortemTone,
  type PostmortemTone,
} from '../../../packages/shared-domain/src/postmortemTone';
import {
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
  mutateDeferredObjectiveSettings,
  normalizeDeferredObjectiveActivePlans,
  normalizeDeferredObjectivePlanHistory,
  normalizeDeferredObjectiveSettings,
  type DeferredObjectiveBackfillConfig,
  type DeferredObjectiveDeviceWriteDeps,
} from '../../plan/deferredObjectives';
import type { DeferredObjectiveSettingsEntry } from '../../plan/deferredObjectives/settings';
import {
  DEFERRED_OBJECTIVES_SETTINGS,
  DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING,
  DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK,
  DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING,
  LEARNED_THERMOSTAT_DEADBAND_C,
} from '../../utils/settingsKeys';
import { isFiniteNumber } from '../../utils/appTypeGuards';
import {
  LEARNED_THERMOSTAT_DEADBAND_MAX_C,
  getLearnedThermostatDeadbandC,
  normaliseLearnedThermostatDeadbandMap,
  updateLearnedThermostatDeadband,
} from '../../utils/learnedThermostatDeadbandStore';
import type { AppContext } from '../appContext';

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
  if (entry.kind === 'temperature') {
    return {
      deviceId,
      deviceName: null,
      objectiveKind: 'temperature',
      deadlineAtMs: entry.deadlineAtMs,
      targetTemperatureC: entry.targetTemperatureC,
      targetPercent: null,
    };
  }
  return {
    deviceId,
    deviceName: null,
    objectiveKind: 'ev_soc',
    deadlineAtMs: entry.deadlineAtMs,
    targetTemperatureC: null,
    targetPercent: entry.targetPercent,
  };
};

const readWatermark = (ctx: AppContext): number | null => {
  const raw: unknown = ctx.homey.settings.get(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK);
  return isFiniteNumber(raw) ? raw : null;
};

/**
 * Advance the deferred-objective observation watermark to "now". If the recorder is still
 * dirty (its `save` callback returned `false`, meaning the last flush attempt didn't actually
 * persist), the watermark is left alone — otherwise the next startup back-fill would skip the
 * window containing the entries that never made it to disk, dropping that history silently.
 */
export const persistDeferredObjectiveObservationWatermark = (
  ctx: AppContext,
  recorder: DeferredObjectivePlanHistoryRecorder | undefined,
): void => {
  if (recorder?.isDirty()) return;
  writeWatermark(ctx, Date.now());
};

export const writeWatermark = (ctx: AppContext, ms: number): void => {
  try {
    ctx.homey.settings.set(DEFERRED_OBJECTIVE_OBSERVATION_WATERMARK, ms);
  } catch (error) {
    ctx.error('Failed to persist deferred-objective observation watermark', error);
  }
};

export function createDeferredObjectivePlanHistoryRecorder(
  ctx: AppContext,
): DeferredObjectivePlanHistoryRecorder {
  const recorder = new DeferredObjectivePlanHistoryRecorder({
    load: () => normalizeDeferredObjectivePlanHistory(
      ctx.homey.settings.get(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING),
    ),
    save: (next) => {
      try {
        ctx.homey.settings.set(DEFERRED_OBJECTIVE_PLAN_HISTORY_SETTING, next);
        return true;
      } catch (error) {
        ctx.error('Failed to persist deferred-objective plan history', error);
        return false;
      }
    },
    endedBus: ctx.deferredObjectiveEndedBus,
    // Resolve hourly spot price + tone for the internal hour-rollover
    // detector. Reads the persisted V2 combined-prices store directly so
    // the postmortem consumes the producer's already-resolved
    // `isCheap`/`isExpensive` flags (per `feedback_layering_resolution_in_producer`).
    // Missing entries / unloaded payload return `null` so the postmortem
    // skips that hour rather than fabricating a contribution.
    resolveHourPrice: (hourStartMs) => resolveHourPriceFromContext(ctx, hourStartMs),
    debugStructured: ctx.getStructuredDebugEmitter('deferred_objectives', 'deferred_objectives'),
    onMetStalledEntry: (entry) => updateLearnedThermostatDeadbandFromEntry(ctx, entry),
  });
  runStartupBackfill(ctx, recorder);
  return recorder;
}

// Translate a met/stalled history entry into a fresh deadband observation and
// EMA-merge it into the persisted per-device map. The observation is the gap
// between the value PELS commanded during planned hours
// (`targetTemperatureC + currentLearnedDeadband`) and the temperature the
// room actually reached before the device's local controller stopped drawing
// (`finalProgressC`). Both inputs are guarded — a corrupted persisted map or
// a missing `finalProgressC` skip the update rather than feeding noise into
// the EMA.
const updateLearnedThermostatDeadbandFromEntry = (
  ctx: AppContext,
  entry: {
    deviceId: string;
    targetTemperatureC: number | null;
    finalProgressC: number | null;
  },
): void => {
  if (entry.targetTemperatureC === null || entry.finalProgressC === null) return;
  if (!isFiniteNumber(entry.targetTemperatureC) || !isFiniteNumber(entry.finalProgressC)) return;
  let rawMap: unknown;
  try {
    rawMap = ctx.homey.settings.get(LEARNED_THERMOSTAT_DEADBAND_C);
  } catch (error) {
    ctx.error('Failed to read learned thermostat deadband', error);
    return;
  }
  const map = normaliseLearnedThermostatDeadbandMap(rawMap);
  const commandedSetpointC = entry.targetTemperatureC + getLearnedThermostatDeadbandC(map, entry.deviceId);
  const observedDeadbandC = commandedSetpointC - entry.finalProgressC;
  // Skip large observations — they indicate a device plateau (e.g. Connected
  // 300 water heater stalled at 61.5 °C against a 65 °C target with a 3.5 °C
  // gap) rather than a thermostat control-loop deadband. The standard 5 °C /
  // 5 min `near_target_idle` classifier path fires for any gap inside the
  // hold band, but a true control-loop deadband signal is by definition
  // small. `LEARNED_THERMOSTAT_DEADBAND_MAX_C` (1.0 °C) is the natural
  // separator: the over-command cap was set to the upper bound of plausible
  // deadbands, so observations exceeding it are not deadband evidence and
  // would corrupt the EMA if mixed in. The `capped_idle` classifier path
  // catches the well-below-target case for `gap > 5 °C` and maps to
  // `metReason: 'stalled_device_capped'`, which the recorder hook already
  // filters out — this guard handles the same physical case for stalls
  // inside the standard hold band where the gap reads as smaller.
  if (observedDeadbandC > LEARNED_THERMOSTAT_DEADBAND_MAX_C) return;
  const nextMap = updateLearnedThermostatDeadband({
    map,
    deviceId: entry.deviceId,
    observedDeadbandC,
  });
  if (nextMap === map) return;
  try {
    ctx.homey.settings.set(LEARNED_THERMOSTAT_DEADBAND_C, nextMap);
  } catch (error) {
    ctx.error('Failed to persist learned thermostat deadband', error);
  }
};

// Look up the persisted V2 combined-prices entry whose hour-aligned
// `startsAt` equals `hourStartMs` and map its already-resolved
// `isCheap`/`isExpensive` flags onto the postmortem tone enum (via the
// shared-domain `resolvePostmortemTone` helper). Returns `null` when no
// entry covers the hour, when `total` is non-finite, or when the payload
// hasn't loaded yet — all three are best-effort skip cases.
const resolveHourPriceFromContext = (
  ctx: AppContext,
  hourStartMs: number,
): { priceValue: number; tone: PostmortemTone } | null => {
  const store = readPriceStore(
    { homey: ctx.homey, requestRefetch: () => ctx.priceCoordinator?.updateCombinedPrices() },
    new Date(),
    ctx.homey.clock.getTimezone(),
  );
  if (!store) return null;
  for (const entry of flattenAllHours(store)) {
    const entryStart = new Date(entry.startsAt).getTime();
    if (!Number.isFinite(entryStart) || entryStart !== hourStartMs) continue;
    if (!Number.isFinite(entry.total)) return null;
    return { priceValue: entry.total, tone: resolvePostmortemTone(entry) };
  }
  return null;
};

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
  const settings = normalizeDeferredObjectiveSettings(
    ctx.homey.settings.get(DEFERRED_OBJECTIVES_SETTINGS),
  );
  const configs = Object.entries(settings.objectivesByDeviceId)
    .map(([deviceId, entry]) => toBackfillConfig(deviceId, entry))
    .filter((c): c is DeferredObjectiveBackfillConfig => c !== null);
  const nowMs = Date.now();
  if (configs.length === 0) {
    // No enabled objectives — advance the watermark anyway. We successfully scanned a window
    // that produced nothing, and on the next restart we don't need to re-scan it.
    // Caveat: a future "enable an objective" action can't retroactively recover deadlines
    // that elapsed inside this skipped window — that fidelity gap is acknowledged in
    // PR-description and would need per-objective enable timestamps to fix.
    writeWatermark(ctx, nowMs);
    return;
  }
  recorder.backfillFromConfig(configs, watermark, nowMs);
  if (recorder.isDirty()) {
    // Back-fill produced new entries — only advance the watermark if we actually persisted
    // them. A failed save keeps the entries in memory for a later retry; leaving the
    // watermark in place means the next startup re-runs the scan idempotently.
    if (!recorder.flushIfDirty()) return;
  }
  writeWatermark(ctx, nowMs);
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
  return new DeferredObjectiveActivePlanRecorder({
    // Return `null` (not an empty payload) when the raw boot read is
    // absent/non-object so the recorder seeds zero plans. NOTE: confirmation of
    // the live-device set is no longer derived from this read's shape — the
    // recorder starts UNCONFIRMED on EVERY boot (absent, non-object, empty,
    // malformed, or wrong-version all reduce to a set the boot read cannot
    // vouch for) and only the first plan-cycle `observe()` confirms it. See
    // `DeferredObjectiveActivePlanRecorder.isLiveSetConfirmed`.
    load: () => {
      const raw: unknown = ctx.homey.settings.get(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING);
      if (!raw || typeof raw !== 'object') return null;
      return normalizeDeferredObjectiveActivePlans(raw);
    },
    save: (next) => {
      try {
        ctx.homey.settings.set(DEFERRED_OBJECTIVE_ACTIVE_PLANS_SETTING, next);
      } catch (error) {
        ctx.error('Failed to persist deferred-objective active plans', error);
      }
    },
    debugStructured: ctx.getStructuredDebugEmitter('deferred_objectives', 'deferred_objectives'),
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
 * Build the shared device-scoped write deps for the hardened objective write
 * primitive. Both the create-smart-task widget path (app.ts) and the deadline
 * Flow cards (via appInit) route their settings writes through ops built on
 * this, so there is exactly one read-modify-write of `DEFERRED_OBJECTIVES_SETTINGS`.
 *
 * `knownLiveDeviceIds` reads the in-memory active-plan recorder's snapshot — the
 * recorder's belief about which devices hold a live objective — so the primitive
 * can refuse a write that would drop those entries after a transient-empty
 * settings read.
 */
export const buildDeferredObjectiveDeviceWriteDeps = (
  ctx: AppContext,
  params: { nowMs: number; rebuildReason: string },
): DeferredObjectiveDeviceWriteDeps => {
  const activePlanRecorder = requireDeferredObjectiveActivePlanRecorder(ctx);
  const planHistoryRecorder = requireDeferredObjectivePlanHistoryRecorder(ctx);
  return {
    read: () => normalizeDeferredObjectiveSettings(ctx.homey.settings.get(DEFERRED_OBJECTIVES_SETTINGS)),
    write: (next) => { ctx.homey.settings.set(DEFERRED_OBJECTIVES_SETTINGS, next); },
    knownLiveDeviceIds: () => Object.keys(activePlanRecorder.getActivePlansSnapshot().plansByDeviceId),
    // While the recorder's live set is unconfirmed (transient-empty boot read,
    // no cycle observed yet), `knownLiveDeviceIds` may be falsely empty — tell
    // the clobber guard so it refuses a sibling-dropping create in that window.
    liveSetAuthoritative: () => activePlanRecorder.isLiveSetConfirmed(),
    activePlanRecorder,
    planHistoryRecorder,
    rebuildPlan: () => ctx.requestFlowPlanRebuild(params.rebuildReason),
    nowMs: params.nowMs,
  };
};

export const disableDeferredObjectiveInSettings = (ctx: AppContext, deviceId: string): void => {
  // Route the read-modify-write through the SAME hardened primitive the create
  // / clear paths use, so a partial transient read can't drop sibling
  // objectives here. The mutator flips just this device's `enabled` flag; the
  // primitive's clobber guard refuses the write if it would lose a sibling the
  // read transiently lost. `touchedDeviceId` is this device, so flipping its
  // own entry is never treated as a drop.
  const activePlanRecorder = requireDeferredObjectiveActivePlanRecorder(ctx);
  let wasEnabled = false;
  const persisted = mutateDeferredObjectiveSettings(
    {
      read: () => normalizeDeferredObjectiveSettings(ctx.homey.settings.get(DEFERRED_OBJECTIVES_SETTINGS)),
      write: (next) => { ctx.homey.settings.set(DEFERRED_OBJECTIVES_SETTINGS, next); },
      knownLiveDeviceIds: () => Object.keys(activePlanRecorder.getActivePlansSnapshot().plansByDeviceId),
      liveSetAuthoritative: () => activePlanRecorder.isLiveSetConfirmed(),
    },
    (current) => {
      const entry = current.objectivesByDeviceId[deviceId];
      wasEnabled = Boolean(entry?.enabled);
      if (!entry || !entry.enabled) {
        // Nothing to flip — return the map unchanged so the guard treats this
        // as a no-op write rather than a drop.
        return { next: current, touchedDeviceId: deviceId };
      }
      return {
        next: {
          ...current,
          objectivesByDeviceId: {
            ...current.objectivesByDeviceId,
            [deviceId]: { ...entry, enabled: false },
          },
        },
        touchedDeviceId: deviceId,
      };
    },
  );
  // Only run the in-memory cleanup when there was an enabled objective AND the
  // disable actually persisted. A no-op (already disabled / absent) or a
  // refused clobber leaves the bus / tracker / active-plan state for the next
  // clean cycle to reconcile, so in-memory state never drifts ahead of what is
  // on disk.
  if (!wasEnabled || !persisted) return;
  // Drop in-memory status + active plan so flow conditions like
  // `deadline_status_is` and the deadline UI agree with the persisted state
  // immediately, instead of seeing the last published snapshot until the
  // next plan cycle's forget-sweep runs.
  ctx.deferredObjectiveStatusBus?.forgetDevice(deviceId);
  // Re-arm the hours-remaining crossing latch so a later re-enabled task with
  // the same deadline still fires its lead-time trigger rather than treating
  // the stale boundary as already crossed.
  ctx.deferredObjectiveHoursRemainingTracker?.forgetDevice(deviceId);
  ctx.deferredObjectiveActivePlanRecorder?.clearForDevice(deviceId);
};
