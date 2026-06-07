import {
  readAllObjectives,
  resolveDeferredObjectiveDeadline,
  type DeferredObjectivePlanRevisionEvent,
  type DeferredObjectiveSettingsEntry,
  type DeferredObjectiveSettingsV1,
} from '../lib/objectives/deferredObjectives';
import type { ObjectiveWriteOutcome } from '../lib/objectives/deferredObjectives';
import type {
  DeferredObjectiveActivePlanStatusV1,
  DeferredObjectiveActivePlanV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import { OBJECTIVE_WRITE_REFUSED_RETRY } from '../packages/shared-domain/src/objectiveWriteStrings';
import { normalizeError } from '../lib/utils/errorUtils';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import { isEvCharger, supportsTemperatureObjective } from './smartTaskDeviceCapability';
import {
  buildSmartTaskEndedTokens,
  buildSmartTaskHoursRemainingTokens,
  buildSmartTaskPlanChangedTokens,
  buildSmartTaskStatusTokens,
  type SmartTaskStatusId,
} from './smartTaskTokens';
import type { FlowCardDeps } from './registerFlowCards';

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

type SmartTaskActiveFlowStatus = SmartTaskStatusId;

export type DropdownArg = string | { id?: string; name?: string };

// Status the user effectively sees while the planner has not yet produced a
// settled active-plan revision for an enabled task (e.g. waiting for prices).
// Once a revision exists, public Flow status follows the active-plan recorder's
// settled status rather than the live per-cycle diagnostic status.
const PENDING_FLOW_STATUS: SmartTaskActiveFlowStatus = 'waiting';

export const getDropdownId = (raw: DropdownArg | undefined): string => (
  (typeof raw === 'object' && raw !== null ? raw.id : raw) ?? ''
).trim();

// Read-only accessor for the persisted objectives map, assembled from the
// per-device keys (`readAllObjectives`). The condition/trigger/autocomplete
// cards and the create/rescue cards' pre-write checks read through this; ALL
// writes go through the device-scoped ops on `deps`
// (`upsertDeferredObjectiveForDevice` / `clearDeferredObjectiveForDevice`),
// which write each device's own settings key.
export const requireSettingsRead = (deps: FlowCardDeps): () => DeferredObjectiveSettingsV1 => (
  deps.getDeferredObjectiveSettings
    ?? (() => readAllObjectives(deps.homey.settings))
);

// A device-scoped write can refuse to persist on a transient un-confirmable
// migration / untrustworthy settings read. The Flow-card run listeners are
// async, so throwing here lets Homey surface a retryable failure to the user
// instead of the card reporting a (false) success while nothing was written.
const throwIfWriteRefused = (outcome: ObjectiveWriteOutcome): void => {
  if (!outcome.persisted) throw new Error(OBJECTIVE_WRITE_REFUSED_RETRY);
};

const validateReadyBy = (raw: unknown): string => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!LOCAL_TIME_PATTERN.test(value)) {
    throw new Error('Ready by must be HH:mm in 24-hour local time (e.g. "07:00").');
  }
  return value;
};

const validateNumberInRange = (
  raw: unknown,
  fieldLabel: string,
  min: number,
  max: number,
): number => {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldLabel} must be a number.`);
  }
  if (value < min || value > max) {
    throw new Error(`${fieldLabel} must be between ${min} and ${max}.`);
  }
  return value;
};

// Maps a raw dropdown arg to the canonical SmartTaskActiveFlowStatus used
// internally by the condition and trigger run-listeners.
//
// Backward-compat aliases accepted here:
//   - 'pending_prices'  → 'waiting'    (internal name used briefly during
//                                        development; never in a shipped
//                                        dropdown but can appear in test-only
//                                        flows or programmatic trigger calls)
//   - 'cannot_meet'     → 'unachievable' (dropdown id from the initial May 10
//                                        release of deadline_status_is; removed
//                                        May 12 when the dropdown was renamed)
//   - 'cannot_finish'   → 'unachievable' (defensive alias — never exposed in
//                                        a shipped dropdown; mirrors the
//                                        label text "Cannot finish")
//   - 'done'            → 'satisfied'  (defensive alias — never in a shipped
//                                        dropdown)
//
// 'none' is intentionally excluded here; it is handled separately by
// `isLegacyNoneStatusMatch` before this function is called.
const normalizeSmartTaskStatusArg = (raw: DropdownArg | undefined): SmartTaskActiveFlowStatus | null => {
  const status = getDropdownId(raw);
  switch (status) {
    case 'waiting':
    case 'pending_prices':
      return 'waiting';
    case 'on_track':
      return 'on_track';
    case 'at_risk':
      return 'at_risk';
    case 'unachievable':
    case 'cannot_meet':
    case 'cannot_finish':
      return 'unachievable';
    case 'satisfied':
    case 'done':
      return 'satisfied';
    default:
      return null;
  }
};

const mapPlanStatusToFlowStatus = (
  status: DeferredObjectiveActivePlanStatusV1,
): SmartTaskActiveFlowStatus => {
  switch (status) {
    case 'on_track':
      return 'on_track';
    case 'at_risk':
      return 'at_risk';
    case 'cannot_meet':
    case 'invalid':
      return 'unachievable';
    case 'satisfied':
      return 'satisfied';
    default:
      return 'unachievable';
  }
};

const mapPreviousPlanStatusToFlowStatus = (
  event: DeferredObjectivePlanRevisionEvent,
): SmartTaskActiveFlowStatus | null => {
  if (event.previousWasPending) return PENDING_FLOW_STATUS;
  return event.previousPlanStatus === null ? null : mapPlanStatusToFlowStatus(event.previousPlanStatus);
};

const mapPlanEventToFlowStatus = (
  event: DeferredObjectivePlanRevisionEvent,
): SmartTaskActiveFlowStatus => (
  event.eventType === 'pending_written'
    ? PENDING_FLOW_STATUS
    : mapPlanStatusToFlowStatus(event.revision.planStatus)
);

// Backward-compat for the 'none' dropdown id from the initial
// `deadline_status_is` card (committed 2026-05-10 as `3ba281d7`, refactored
// out 2026-05-12 as `d67e0d97`). v2.7.0 — the first release to ship the card
// — was bumped 2026-05-16, so 'none' never reached a published version.
// The compat path is kept anyway because (a) pre-release test installs in
// that window may persist 'none' in flow args and (b) advanced users can
// hand-edit flow card JSON in Homey, so a flow may carry an id outside the
// shipped dropdown set.
//
// See `normalizeSmartTaskStatusArg` above for the other four legacy ids
// (`pending_prices`, `cannot_meet`, `cannot_finish`, `done`) — 'none' is
// handled separately here because its truth depends on a settings lookup
// rather than a simple alias rewrite.
//
// Semantics: 'none' means "no active smart task for this device", i.e. the
// device has no enabled objective entry in settings. Returns `null` for any
// other raw status so the caller can fall through to the canonical path.
// `hasEntry` must be pre-resolved by the caller to avoid a redundant settings
// read (the caller needs it for the canonical path as well).
const isLegacyNoneStatusMatch = (
  rawStatus: string,
  hasEntry: boolean,
): boolean | null => {
  if (rawStatus !== 'none') return null;
  return !hasEntry;
};

export function registerDeadlineObjectiveCards(deps: FlowCardDeps): void {
  registerSetTemperatureDeadlineCard(deps);
  registerSetEvChargeDeadlineCard(deps);
  registerClearDeadlineCard(deps);
  registerDeadlineStatusChangedTrigger(deps);
  registerDeadlineEndedTrigger(deps);
  registerDeadlinePlanChangedTrigger(deps);
  registerSmartTaskHoursRemainingTrigger(deps);
  registerDeadlineStatusIsCondition(deps);
  registerHasActiveDeadlineCondition(deps);
}

function registerSetTemperatureDeadlineCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard('set_temperature_deadline');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as {
      device?: RawFlowDeviceArg;
      target_c?: unknown;
      ready_by?: unknown;
    } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) throw new Error('Device must be provided.');
    const snapshot = await deps.getSnapshot();
    const device = snapshot.find((entry) => entry.id === deviceId);
    if (!device) throw new Error(`Device '${deviceId}' was not found.`);
    if (!supportsTemperatureObjective(device)) {
      throw new Error(`Device '${device.name.trim() || deviceId}' does not support temperature deadlines.`);
    }
    const targetTemperatureC = validateTargetTemperature(payload?.target_c, device);
    const deadlineLocalTime = validateReadyBy(payload?.ready_by);
    const deadlineAtMs = resolveReadyByToDeadlineAtMs(deps, deadlineLocalTime);
    const entry: DeferredObjectiveSettingsEntry = {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC,
      deadlineAtMs,
    };
    // Device-scoped op writes this device's own settings key + runs the shared
    // notify/flush/rebuild chokepoint. It preserves any standing rescue
    // permission across this update by default (the rescue card promises it
    // sticks until changed/cleared). A per-key write touches only this device,
    // so it cannot clobber a sibling task.
    throwIfWriteRefused(
      deps.upsertDeferredObjectiveForDevice({ deviceId, deviceName: device.name ?? null, entry }),
    );
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot.filter(supportsTemperatureObjective), query);
  });
}

const validateTargetTemperature = (raw: unknown, device: TargetDeviceSnapshot): number => {
  const target = device.targets[0];
  const min = typeof target?.min === 'number' && Number.isFinite(target.min) ? target.min : -50;
  const max = typeof target?.max === 'number' && Number.isFinite(target.max) ? target.max : 100;
  return validateNumberInRange(raw, 'Target temperature', min, max);
};

function registerSetEvChargeDeadlineCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard('set_ev_charge_deadline');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as {
      device?: RawFlowDeviceArg;
      target_percent?: unknown;
      ready_by?: unknown;
    } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) throw new Error('EV charger must be provided.');
    const snapshot = await deps.getSnapshot();
    const device = snapshot.find((entry) => entry.id === deviceId);
    if (!device) throw new Error(`Device '${deviceId}' was not found.`);
    if (!isEvCharger(device)) {
      throw new Error(`Device '${device.name.trim() || deviceId}' is not an EV charger.`);
    }
    const targetPercent = validateNumberInRange(payload?.target_percent, 'Target battery (%)', 1, 100);
    const deadlineLocalTime = validateReadyBy(payload?.ready_by);
    const deadlineAtMs = resolveReadyByToDeadlineAtMs(deps, deadlineLocalTime);
    const entry: DeferredObjectiveSettingsEntry = {
      enabled: true,
      kind: 'ev_soc',
      enforcement: 'soft',
      targetPercent,
      deadlineAtMs,
    };
    // Device-scoped op writes this device's own settings key + runs the shared
    // notify/flush/rebuild chokepoint, preserving any standing rescue permission
    // by default. A per-key write touches only this device, so it cannot clobber
    // a sibling task.
    throwIfWriteRefused(
      deps.upsertDeferredObjectiveForDevice({ deviceId, deviceName: device.name ?? null, entry }),
    );
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot.filter(isEvCharger), query);
  });
}

const resolveReadyByToDeadlineAtMs = (deps: FlowCardDeps, deadlineLocalTime: string): number => {
  const nowMs = deps.getNow().getTime();
  const resolution = resolveDeferredObjectiveDeadline({
    nowMs,
    timeZone: deps.getTimeZone(),
    deadlineLocalTime,
  });
  if (resolution.deadlineAtMs === null || resolution.deadlineAtMs <= nowMs) {
    throw new Error(`Could not resolve "${deadlineLocalTime}" to a future moment in time.`);
  }
  return resolution.deadlineAtMs;
};

const resolveDeviceName = async (deps: FlowCardDeps, deviceId: string): Promise<string | null> => {
  try {
    const snapshot = await deps.getSnapshot();
    return snapshot.find((entry) => entry.id === deviceId)?.name ?? null;
  } catch {
    return null;
  }
};

function registerClearDeadlineCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard('clear_deadline');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) throw new Error('Device must be provided.');
    const hadEntry = Boolean(requireSettingsRead(deps)().objectivesByDeviceId[deviceId]);
    // Device-scoped op unsets this device's own settings key plus runs the
    // shared notify/flush/rebuild chokepoint. A per-key unset cannot drop a
    // sibling task, so there is no refusal branch.
    // Throw on a refused clear BEFORE the forget side effects below — dropping
    // the bus / hours-tracker memory while the objective is still persisted
    // would desync the UI from a task that never actually cleared.
    throwIfWriteRefused(deps.clearDeferredObjectiveForDevice({
      deviceId,
      deviceName: hadEntry ? await resolveDeviceName(deps, deviceId) : null,
    }));
    // Flow-card-only side effects of forgetting a task: drop the live status bus
    // / hours-tracker memory so lifecycle-only surfaces do not keep stale state.
    // The public status-change trigger is active-plan-revision backed, so it no
    // longer needs a separate suppression cache here.
    deps.getDeferredObjectiveStatusBus?.()?.forgetDevice(deviceId);
    deps.getDeferredObjectiveHoursRemainingTracker?.()?.forgetDevice(deviceId);
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    const settings = requireSettingsRead(deps)();
    const activeIds = new Set(Object.keys(settings.objectivesByDeviceId));
    const candidates = activeIds.size > 0
      ? snapshot.filter((device) => activeIds.has(device.id))
      : snapshot;
    return buildDeviceAutocompleteOptions(candidates, query);
  });
}

function registerDeadlineStatusChangedTrigger(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getTriggerCard('deadline_status_changed');
  card.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg } | null;
    const stateRecord = (state ?? {}) as { deviceId?: string };
    const wantedDeviceId = getDeviceIdFromFlowArg(payload?.device);
    return Boolean(wantedDeviceId && wantedDeviceId === stateRecord.deviceId);
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });

  const bus = deps.getDeferredObjectivePlanRevisionBus?.();
  if (!bus) return;
  bus.onRevision((event) => {
    let tokens: Record<string, unknown>;
    try {
      const previousStatus = mapPreviousPlanStatusToFlowStatus(event);
      // No prior public status means task creation/discovery, not a status change.
      if (previousStatus === null) return;
      const flowStatus = mapPlanEventToFlowStatus(event);
      if (previousStatus === flowStatus) return;
      tokens = buildSmartTaskStatusTokens(event, flowStatus);
    } catch (err) {
      deps.getStructuredLogger('flow')?.error({
        event: 'deadline_status_changed_tokens_build_failed',
        deviceId: event.deviceId,
        err: normalizeError(err),
      });
      return;
    }
    void card.trigger?.(tokens, { deviceId: event.deviceId })
      .catch((err: Error) => deps.getStructuredLogger('flow')?.error({
        event: 'deadline_status_changed_trigger_failed',
        deviceId: event.deviceId,
        err: normalizeError(err),
      }));
  });
}

function registerDeadlineEndedTrigger(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getTriggerCard('deadline_ended');
  card.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg } | null;
    const stateRecord = (state ?? {}) as { deviceId?: string };
    const wantedDeviceId = getDeviceIdFromFlowArg(payload?.device);
    return Boolean(wantedDeviceId && wantedDeviceId === stateRecord.deviceId);
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });

  const bus = deps.getDeferredObjectiveEndedBus?.();
  if (!bus) return;
  bus.onEnded((event) => {
    let tokens: Record<string, unknown>;
    try {
      tokens = buildSmartTaskEndedTokens(event);
    } catch (err) {
      // Swallow listener-side errors so a malformed event cannot unwind back
      // into the plan-history finalization that published it.
      deps.getStructuredLogger('flow')?.error({
        event: 'deadline_ended_tokens_build_failed',
        deviceId: event.deviceId,
        err: normalizeError(err),
      });
      return;
    }
    void card.trigger?.(tokens, { deviceId: event.deviceId })
      .catch((err: Error) => deps.getStructuredLogger('flow')?.error({
        event: 'deadline_ended_trigger_failed',
        deviceId: event.deviceId,
        err: normalizeError(err),
      }));
  });
}

function registerDeadlinePlanChangedTrigger(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getTriggerCard('deadline_plan_changed');
  card.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg } | null;
    const stateRecord = (state ?? {}) as { deviceId?: string };
    const wantedDeviceId = getDeviceIdFromFlowArg(payload?.device);
    return Boolean(wantedDeviceId && wantedDeviceId === stateRecord.deviceId);
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });

  const bus = deps.getDeferredObjectivePlanRevisionBus?.();
  if (!bus) return;
  bus.onRevision((event) => {
    if (event.eventType !== 'revision_written') return;
    if (!event.allocationChanged) return;
    let tokens: Record<string, unknown>;
    try {
      tokens = buildSmartTaskPlanChangedTokens(event, deps.getTimeZone());
    } catch (err) {
      // Swallow listener-side errors so a malformed event cannot unwind back
      // into the plan-engine cycle that published it.
      deps.getStructuredLogger('flow')?.error({
        event: 'deadline_plan_changed_tokens_build_failed',
        deviceId: event.deviceId,
        err: normalizeError(err),
      });
      return;
    }
    void card.trigger?.(tokens, { deviceId: event.deviceId })
      .catch((err: Error) => deps.getStructuredLogger('flow')?.error({
        event: 'deadline_plan_changed_trigger_failed',
        deviceId: event.deviceId,
        err: normalizeError(err),
      }));
  });
}

// Validates the `hours` threshold arg the same way the set-deadline cards
// validate their numeric ranges, then returns the finite number. Mirrors the
// 1..24 range declared in the manifest.
const resolveHoursThreshold = (raw: unknown): number | null => {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  return value;
};

function registerSmartTaskHoursRemainingTrigger(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getTriggerCard('smart_task_hours_remaining');
  card.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg; hours?: unknown } | null;
    const stateRecord = (state ?? {}) as {
      deviceId?: string;
      hoursRemaining?: number;
      previousHoursRemaining?: number | null;
    };
    const wantedDeviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!wantedDeviceId || wantedDeviceId !== stateRecord.deviceId) return false;
    const threshold = resolveHoursThreshold(payload?.hours);
    if (threshold === null || typeof stateRecord.hoursRemaining !== 'number') return false;
    // Fire only on the cycle where remaining first drops to/below this flow's
    // threshold. The crossing carries the previous emitted boundary; a genuine
    // downward crossing of *this* threshold means it was previously above it.
    // `previousHoursRemaining == null` is the first crossing for the deadline
    // (freshly armed / re-armed / created already under the threshold) and
    // counts as "previously above" so it fires exactly once.
    const previous = stateRecord.previousHoursRemaining;
    const wasAboveThreshold = previous === null || previous === undefined || previous > threshold;
    return stateRecord.hoursRemaining <= threshold && wasAboveThreshold;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });

  const bus = deps.getDeferredObjectiveHoursRemainingBus?.();
  if (!bus) return;
  bus.onCrossing((event) => {
    let tokens: Record<string, unknown>;
    try {
      tokens = buildSmartTaskHoursRemainingTokens(event);
    } catch (err) {
      deps.getStructuredLogger('flow')?.error({
        event: 'smart_task_hours_remaining_tokens_build_failed',
        deviceId: event.deviceId,
        err: normalizeError(err),
      });
      return;
    }
    void card.trigger?.(tokens, {
      deviceId: event.deviceId,
      hoursRemaining: event.hoursRemaining,
      previousHoursRemaining: event.previousHoursRemaining,
    }).catch((triggerErr: Error) => deps.getStructuredLogger('flow')?.error({
      event: 'smart_task_hours_remaining_trigger_failed',
      deviceId: event.deviceId,
      err: normalizeError(triggerErr),
    }));
  });
}

function registerDeadlineStatusIsCondition(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getConditionCard('deadline_status_is');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg; status?: DropdownArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) return false;
    const rawStatus = getDropdownId(payload?.status);
    const settings = requireSettingsRead(deps)();
    const entry = settings.objectivesByDeviceId[deviceId];
    const hasEntry = Boolean(entry?.enabled);
    const legacyNoneMatch = isLegacyNoneStatusMatch(rawStatus, hasEntry);
    if (legacyNoneMatch !== null) return legacyNoneMatch;
    const wantedStatus = normalizeSmartTaskStatusArg(payload?.status);
    if (!wantedStatus) return false;
    const activePlans = deps.getDeferredObjectiveActivePlans?.() ?? null;
    if (activePlans === null) return false;
    const plan = activePlans.plansByDeviceId[deviceId] ?? null;
    const effectiveStatus = resolveEffectiveStatus(
      plan,
      hasEntry,
      entry?.deadlineAtMs ?? null,
      deps.getNow().getTime(),
    );
    return effectiveStatus !== null && effectiveStatus === wantedStatus;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });
}

// Resolves the public, settled smart-task status used by Flow conditions.
// Four cases:
//   1. No enabled objective entry → no task; nothing matches.
//   2. Persisted plan is past deadline → no active status matches; the ended
//      trigger owns that event.
//   3. No settled revision yet → waiting.
//   4. Settled revision exists → use `latest.planStatus`.
const resolveEffectiveStatus = (
  plan: DeferredObjectiveActivePlanV1 | null,
  hasEntry: boolean,
  objectiveDeadlineAtMs: number | null,
  nowMs: number,
): SmartTaskActiveFlowStatus | null => {
  if (!hasEntry) return null;
  if (objectiveDeadlineAtMs !== null && objectiveDeadlineAtMs <= nowMs) return null;
  if (plan !== null && plan.deadlineAtMs <= nowMs) return null;
  if (plan === null || plan.pending || plan.latest === null) return PENDING_FLOW_STATUS;
  return mapPlanStatusToFlowStatus(plan.latest.planStatus);
};

function registerHasActiveDeadlineCondition(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getConditionCard('has_active_deadline');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) return false;
    const settings = requireSettingsRead(deps)();
    return Boolean(settings.objectivesByDeviceId[deviceId]?.enabled);
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });
}
