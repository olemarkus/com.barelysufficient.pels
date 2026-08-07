import type { ObjectiveDeviceInput } from '../../objectives/types';
import type { DeferredObjectiveSettingsEntry, DeferredObjectiveSettingsV1 } from './settings';

// Deprecated compatibility implementation for callers/tests that still import
// the former equal-share allocator. Runtime planning no longer consumes these
// counts; `PriorityAllocationTracker` plus exact higher-task reservations owns
// coordination now. The grace constant remains shared during the transition.

// Survive one full cooldown window of transient SDK misses before dropping a
// task from the eligible-task count. Without this window, a single Homey SDK
// snapshot eviction (`feedback_homey_sdk_unreliable`) drops the task from
// `params.deviceById` for one plan cycle and surviving siblings briefly see
// `headroom / (N−1)` — diagnostic verdicts then oscillate `on_track` ↔
// `at_risk: feasible_above_floor` across adjacent cycles. Capacity guard still
// holds regardless, so this is verdict-flicker hardening only.
//
// Picked to align with the abandon-grace pattern in `planHistory.ts`
// (`ABANDON_GRACE_MS = 60 min`): both want "tolerate a long-ish gap before
// reclassifying state derived from a possibly-flaky SDK read." A shorter
// window leaves the flicker visible on slow-recovering devices; a longer
// window keeps a genuinely-removed device counted past the point it can
// affect the shared headroom (harmless — over-counting just keeps everyone
// closer to the min-step floor, the strictly conservative direction).
export const ELIGIBILITY_ABANDON_GRACE_MS = 60 * 60 * 1000;

// Pure eligibility predicate, identical to `fullyReserved` in
// `rescueReplan.ts` (the only path that actually consumes
// `reservedHeadroomKw`): enabled, has device, device is strictly
// top-priority, both rescue permissions are `'always'`.
const isEligibleNow = (
  deviceId: string,
  objective: DeferredObjectiveSettingsEntry,
  deviceById: Map<string, ObjectiveDeviceInput>,
): boolean => {
  if (!objective.enabled) return false;
  if (objective.rescue?.exemptFromBudget !== 'always') return false;
  if (objective.rescue?.limitLowerPriorityDevices !== 'always') return false;
  const device = deviceById.get(deviceId);
  if (!device) return false;
  if (device.priority !== 1) return false;
  return true;
};

// Snapshot of an eligible device captured at observation time. The deadline
// is cached so per-bucket counts can drop the task once its deadline has
// passed (see `over-counts in late-horizon buckets` TODO) without needing to
// re-read settings (which may have changed by then).
type EligibilityEntry = {
  // Last cycle this device was observed as eligible. Drives the grace-window
  // check.
  lastSeenAtMs: number;
  // Deadline cached from the settings entry observed when this device was
  // last eligible. Per-bucket counts exclude this entry once `bucketStartMs`
  // reaches the deadline so a task that drops out of eligibility mid-horizon
  // (its deadline elapses) is not counted in later buckets' denominators.
  deadlineAtMs: number;
};

// Historical equal-share tracker retained for compatibility with direct
// callers. It preserves a small in-memory map of "last cycle each device was
// seen eligible" so a transient SDK-side device-snapshot eviction does not
// flicker the count downward for one cycle — see
// `ELIGIBILITY_ABANDON_GRACE_MS`. Current runtime planning uses ordered exact
// reservations in `priorityAllocation.ts` instead.
//
// Lossy-restart contract: the grace map is **not persisted**. After a PELS
// restart it rebuilds from the first observed cycle, so a restart immediately
// followed by a transient SDK miss could still flicker the count for one
// cycle. Persisting the map would require a new settings key (contract
// surgery); the trade-off is acceptable because the worst-case impact is a
// single-cycle verdict oscillation, identical to today's behaviour, only on
// the first cycle after restart instead of an arbitrary cycle.
//
export class ConcurrentEligibleTaskTracker {
  private lastSeenByDeviceId = new Map<string, EligibilityEntry>();

  // Refresh the eligibility map for the current cycle. Devices currently
  // eligible bump their `lastSeenAtMs`; devices absent this cycle stay in
  // the map until the grace window elapses (so `count` keeps including them
  // while we wait for the SDK to recover); devices that have been absent
  // beyond the grace window are pruned.
  observe(params: {
    settings: DeferredObjectiveSettingsV1;
    deviceById: Map<string, ObjectiveDeviceInput>;
    nowMs: number;
    // Multi-home v1: `true` marks a task's device as belonging to a
    // separate-meter sub-home — such a task must not shrink main tasks'
    // reserved shares, so it is excluded from the denominator.
    isDeviceInSubHome?: (deviceId: string) => boolean;
  }): void {
    const { settings, deviceById, nowMs } = params;
    for (const [deviceId, objective] of Object.entries(settings.objectivesByDeviceId)) {
      // Authoritative multi-home exclusion: membership is user-configured
      // state (a pin / zone assignment), not a flaky SDK read, so the
      // abandon-grace window does NOT apply — a pre-relocation entry is pruned
      // immediately instead of diluting siblings for up to the grace window.
      if (params.isDeviceInSubHome?.(deviceId) === true) {
        this.lastSeenByDeviceId.delete(deviceId);
        continue;
      }
      if (!isEligibleNow(deviceId, objective, deviceById)) continue;
      this.lastSeenByDeviceId.set(deviceId, {
        lastSeenAtMs: nowMs,
        deadlineAtMs: objective.deadlineAtMs,
      });
    }
    this.pruneAbandoned(nowMs);
  }

  // Count the eligible tasks the planner should split this bucket's
  // reserved headroom across. When `bucketStartMs` is provided, tasks whose
  // cached deadline has already passed at the bucket start are excluded —
  // a task no longer eligible mid-horizon must not stay in the denominator
  // for later buckets. Without a bucket timestamp the count returns every
  // task within the grace window (the legacy whole-horizon count).
  count(params: { nowMs: number; bucketStartMs?: number }): number {
    const { nowMs, bucketStartMs } = params;
    let total = 0;
    for (const entry of this.lastSeenByDeviceId.values()) {
      if (nowMs - entry.lastSeenAtMs >= ELIGIBILITY_ABANDON_GRACE_MS) continue;
      if (bucketStartMs !== undefined && entry.deadlineAtMs <= bucketStartMs) continue;
      total += 1;
    }
    return total;
  }

  private pruneAbandoned(nowMs: number): void {
    for (const [deviceId, entry] of this.lastSeenByDeviceId) {
      if (nowMs - entry.lastSeenAtMs >= ELIGIBILITY_ABANDON_GRACE_MS) {
        this.lastSeenByDeviceId.delete(deviceId);
      }
    }
  }
}

// Legacy free-function helper. Observes + counts in a single call against an
// ephemeral tracker so callers that don't need the grace window or per-bucket
// counts keep their previous one-shot semantics.
export const countConcurrentEligibleTasks = (params: {
  settings: DeferredObjectiveSettingsV1;
  deviceById: Map<string, ObjectiveDeviceInput>;
  isDeviceInSubHome?: (deviceId: string) => boolean;
}): number => {
  const tracker = new ConcurrentEligibleTaskTracker();
  tracker.observe({ ...params, nowMs: 0 });
  return tracker.count({ nowMs: 0 });
};

// Historical helper retained for callers that still need the former
// per-bucket count API. Runtime diagnostics no longer use it.
export const resolveConcurrentEligibleCount = (params: {
  settings: DeferredObjectiveSettingsV1;
  deviceById: Map<string, ObjectiveDeviceInput>;
  nowMs: number;
  tracker?: ConcurrentEligibleTaskTracker;
  // Multi-home v1 exclusion, threaded to `observe` (see the tracker's doc).
  isDeviceInSubHome?: (deviceId: string) => boolean;
}): number | ((bucketStartMs: number) => number) => {
  const { settings, deviceById, nowMs, tracker, isDeviceInSubHome } = params;
  if (!tracker) {
    return countConcurrentEligibleTasks({ settings, deviceById, isDeviceInSubHome });
  }
  tracker.observe({ settings, deviceById, nowMs, isDeviceInSubHome });
  return (bucketStartMs: number) => tracker.count({ nowMs, bucketStartMs });
};
