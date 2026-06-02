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
  ...(entry.rescue ? { rescue: entry.rescue } : {}),
});

/**
 * Apply a user-initiated change to a device's deferred objective. Notifies both recorders so
 * the active-plan hero and the plan-history audit trail stay consistent with intent:
 *
 * - Replace (different deadline OR same deadline + different target/enforcement): finalize the
 *   prior history run as `'replaced'` (only when the prior deadline is still in the future —
 *   see the deadline-passed gate below), seed a fresh pending active plan.
 * - Clear: finalize the prior history run as `'abandoned'` (same gate), drop the active plan.
 * - New: just seed the active plan; nothing to finalize.
 *
 * Same-deadline target changes are deliberately treated as two separate runs: the prior
 * committed plan is finalized for history, and the active record is replaced in-place with a
 * pending plan for the replacement objective.
 *
 * Caller responsibility: pass the entries actually persisted in settings before/after the
 * write, so this helper does not need to read settings itself. The runtime auto-disable path
 * (deadline elapsed) does *not* go through here — that runs through
 * `deadlineJustPassed` / `finalizeStaleRecords` which classifies the run as
 * `'deadline_passed'`, not `'replaced'`/`'abandoned'`.
 *
 * Deadline-passed gate: when the prior entry's deadline has already elapsed at `nowMs`, the
 * user-change path swaps `finalizeForUserChange` for `finalizeElapsedDeadline`, which pushes
 * a `'deadline_passed'` history entry synchronously (resolving to `'met'` / `'missed'` based
 * on observed progress) instead of the muted `'replaced'` / `'abandoned'` shape. The
 * synchronous path matters in `power_source = flow` mode where the next plan cycle can be
 * arbitrarily delayed — a restart in that window would otherwise drop the just-completed
 * run from history entirely. Without this gate, a user creating the next task at the old
 * deadline (e.g. a "When deadline reached" Flow rolling into "Set deadline") would
 * misclassify a run that actually reached its deadline.
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
  const prevDeadlineFuture = prevActive && prevEntry !== undefined && prevEntry.deadlineAtMs > nowMs;

  if (prevActive && !nextActive) {
    if (prevDeadlineFuture) {
      planHistoryRecorder.finalizeForUserChange(deviceId, nowMs, 'abandoned');
    } else {
      planHistoryRecorder.finalizeElapsedDeadline(deviceId, nowMs);
    }
    activePlanRecorder.clearForDevice(deviceId);
    return;
  }
  if (prevActive && nextActive && !objectivesMatch(prevEntry, nextEntry)) {
    if (prevDeadlineFuture) {
      planHistoryRecorder.finalizeForUserChange(deviceId, nowMs, 'replaced');
    } else {
      planHistoryRecorder.finalizeElapsedDeadline(deviceId, nowMs);
    }
    activePlanRecorder.markPending(seedFromEntry(deviceId, deviceName, nextEntry), nowMs);
    return;
  }
  if (!prevActive && nextActive) {
    activePlanRecorder.markPending(seedFromEntry(deviceId, deviceName, nextEntry), nowMs);
  }
};
