import type {
  ActivePlanFlowCardSeed,
  DeferredObjectiveActivePlanRecorder,
} from './activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from './planHistory';
import type { DeferredObjectiveSettingsEntry } from './settings';

export type DeferredObjectiveChangeInput = {
  deviceId: string;
  deviceName: string | null;
  prevEntry: DeferredObjectiveSettingsEntry | undefined;
  nextEntry: DeferredObjectiveSettingsEntry | undefined;
  nowMs: number;
};

const isActive = (entry: DeferredObjectiveSettingsEntry | undefined): entry is DeferredObjectiveSettingsEntry => (
  entry !== undefined && entry.enabled
);

const objectivesMatch = (
  a: DeferredObjectiveSettingsEntry,
  b: DeferredObjectiveSettingsEntry,
): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.deadlineAtMs !== b.deadlineAtMs) return false;
  if (a.kind === 'temperature' && b.kind === 'temperature') {
    return a.targetTemperatureC === b.targetTemperatureC && a.enforcement === b.enforcement;
  }
  if (a.kind === 'ev_soc' && b.kind === 'ev_soc') {
    return a.targetPercent === b.targetPercent && a.enforcement === b.enforcement;
  }
  return false;
};

const seedFromEntry = (
  deviceId: string,
  deviceName: string | null,
  entry: DeferredObjectiveSettingsEntry,
): ActivePlanFlowCardSeed => ({
  deviceId,
  deviceName,
  objectiveKind: entry.kind,
  targetTemperatureC: entry.kind === 'temperature' ? entry.targetTemperatureC : null,
  targetPercent: entry.kind === 'ev_soc' ? entry.targetPercent : null,
  deadlineAtMs: entry.deadlineAtMs,
  enforcement: entry.enforcement,
});

/**
 * Apply a user-initiated change to a device's deferred objective. Notifies both recorders so
 * the active-plan hero and the plan-history audit trail stay consistent with intent:
 *
 * - Replace (different deadline OR same deadline + different target/enforcement): finalize the
 *   prior history run as `'replaced'`, seed a fresh pending active plan.
 * - Clear: finalize the prior history run as `'abandoned'`, drop the active plan.
 * - New: just seed the active plan; nothing to finalize.
 *
 * Same-deadline target changes are deliberately treated as two history entries (each with a
 * stable target to judge outcome against) while the active-plan recorder keeps a single record
 * across the change via its `objective_changed` revision. The asymmetry is intentional: live
 * hero vs. audit trail.
 *
 * Caller responsibility: pass the entries actually persisted in settings before/after the
 * write, so this helper does not need to read settings itself. The runtime auto-disable path
 * (deadline elapsed) does *not* go through here — that runs through
 * `deadlineJustPassed` / `finalizeStaleRecords` which classifies the run as
 * `'deadline_passed'`, not `'replaced'`/`'abandoned'`.
 */
export const applyDeferredObjectiveChange = (
  params: DeferredObjectiveChangeInput & {
    planHistoryRecorder: DeferredObjectivePlanHistoryRecorder;
    activePlanRecorder: DeferredObjectiveActivePlanRecorder;
  },
): void => {
  const {
    deviceId,
    deviceName,
    prevEntry,
    nextEntry,
    nowMs,
    planHistoryRecorder,
    activePlanRecorder,
  } = params;

  const prevActive = isActive(prevEntry);
  const nextActive = isActive(nextEntry);

  if (prevActive && !nextActive) {
    planHistoryRecorder.finalizeForUserChange(deviceId, nowMs, 'abandoned');
    activePlanRecorder.clearForDevice(deviceId);
    return;
  }
  if (prevActive && nextActive && !objectivesMatch(prevEntry, nextEntry)) {
    planHistoryRecorder.finalizeForUserChange(deviceId, nowMs, 'replaced');
    activePlanRecorder.markPending(seedFromEntry(deviceId, deviceName, nextEntry), nowMs);
    return;
  }
  if (!prevActive && nextActive) {
    activePlanRecorder.markPending(seedFromEntry(deviceId, deviceName, nextEntry), nowMs);
  }
};
