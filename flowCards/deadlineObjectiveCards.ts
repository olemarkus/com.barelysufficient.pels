import {
  normalizeDeferredObjectiveSettings,
  resolveDeferredObjectiveDeadline,
  type DeferredObjectiveSettingsEntry,
  type DeferredObjectiveSettingsV1,
  type DeferredObjectiveStatusSnapshot,
} from '../lib/plan/deferredObjectives';
import { DEFERRED_OBJECTIVES_SETTINGS } from '../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
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

type LastSmartTaskFlowStatus = {
  status: SmartTaskActiveFlowStatus;
  deadlineAtMs: number | null;
};

export type DropdownArg = string | { id?: string; name?: string };
type InternalTaskStatus =
  | DeferredObjectiveStatusSnapshot['status']
  | DeferredObjectiveStatusSnapshot['previousStatus'];

// Status the user effectively sees while the planner has not yet produced a
// horizon plan for an enabled task (e.g. waiting for prices). Mirrors the
// `'waiting'` value the trigger emits when the bus transitions to an
// `unknown` snapshot from a non-`none` prior status. (First observations
// where the prior is `none` are suppressed as task creation, not a status
// change.)
const PENDING_FLOW_STATUS: SmartTaskActiveFlowStatus = 'waiting';

export const getDropdownId = (raw: DropdownArg | undefined): string => (
  (typeof raw === 'object' && raw !== null ? raw.id : raw) ?? ''
).trim();

export const requireSettingsAccessors = (deps: FlowCardDeps): {
  read: () => DeferredObjectiveSettingsV1;
  write: (next: DeferredObjectiveSettingsV1) => void;
} => {
  const read = deps.getDeferredObjectiveSettings
    ?? (() => normalizeDeferredObjectiveSettings(deps.homey.settings.get(DEFERRED_OBJECTIVES_SETTINGS)));
  const write = deps.setDeferredObjectiveSettings
    ?? ((next: DeferredObjectiveSettingsV1) => deps.homey.settings.set(DEFERRED_OBJECTIVES_SETTINGS, next));
  return { read, write };
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

export const upsertObjective = (
  settings: DeferredObjectiveSettingsV1,
  deviceId: string,
  entry: DeferredObjectiveSettingsEntry,
): DeferredObjectiveSettingsV1 => ({
  version: settings.version,
  objectivesByDeviceId: { ...settings.objectivesByDeviceId, [deviceId]: entry },
});

const removeObjective = (
  settings: DeferredObjectiveSettingsV1,
  deviceId: string,
): DeferredObjectiveSettingsV1 => {
  if (!(deviceId in settings.objectivesByDeviceId)) return settings;
  const { [deviceId]: _removed, ...rest } = settings.objectivesByDeviceId;
  return { version: settings.version, objectivesByDeviceId: rest };
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

const mapInternalTaskStatusToFlowStatus = (status: InternalTaskStatus): SmartTaskActiveFlowStatus | null => {
  switch (status) {
    case 'none':
      return null;
    case 'unknown':
      return 'waiting';
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
      return 'waiting';
  }
};

const mapSnapshotToFlowStatus = (snapshot: DeferredObjectiveStatusSnapshot): SmartTaskActiveFlowStatus => {
  return mapInternalTaskStatusToFlowStatus(snapshot.status) ?? 'waiting';
};

const mapPreviousStatusToFlowStatus = (
  previousStatus: DeferredObjectiveStatusSnapshot['previousStatus'],
): SmartTaskActiveFlowStatus | null => mapInternalTaskStatusToFlowStatus(previousStatus);

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
  // Shared between the trigger registration and `clear_deadline` so wiping a
  // task wipes the trigger's suppression cache too.
  const lastFlowStatusByDeviceId = new Map<string, LastSmartTaskFlowStatus>();
  registerSetTemperatureDeadlineCard(deps);
  registerSetEvChargeDeadlineCard(deps);
  registerClearDeadlineCard(deps, lastFlowStatusByDeviceId);
  registerDeadlineStatusChangedTrigger(deps, lastFlowStatusByDeviceId);
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
    const accessors = requireSettingsAccessors(deps);
    const settings = accessors.read();
    const prevEntry = settings.objectivesByDeviceId[deviceId];
    const nextEntry: DeferredObjectiveSettingsEntry = {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC,
      deadlineAtMs,
      // Preserve any standing rescue permission across a deadline update — the rescue
      // card promises it sticks until changed or the task is cleared, and upsertObjective
      // replaces the entry wholesale.
      ...(prevEntry?.rescue ? { rescue: prevEntry.rescue } : {}),
    };
    accessors.write(upsertObjective(settings, deviceId, nextEntry));
    notifyObjectiveChange(deps, { device, prevEntry, nextEntry });
    deps.rebuildPlan('deadline_objective_card_set');
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
    const accessors = requireSettingsAccessors(deps);
    const settings = accessors.read();
    const prevEntry = settings.objectivesByDeviceId[deviceId];
    const nextEntry: DeferredObjectiveSettingsEntry = {
      enabled: true,
      kind: 'ev_soc',
      enforcement: 'soft',
      targetPercent,
      deadlineAtMs,
      // Preserve any standing rescue permission across a deadline update — the rescue
      // card promises it sticks until changed or the task is cleared, and upsertObjective
      // replaces the entry wholesale.
      ...(prevEntry?.rescue ? { rescue: prevEntry.rescue } : {}),
    };
    accessors.write(upsertObjective(settings, deviceId, nextEntry));
    notifyObjectiveChange(deps, { device, prevEntry, nextEntry });
    deps.rebuildPlan('deadline_objective_card_set');
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

const notifyObjectiveChange = (deps: FlowCardDeps, params: {
  device: TargetDeviceSnapshot;
  prevEntry: DeferredObjectiveSettingsEntry | undefined;
  nextEntry: DeferredObjectiveSettingsEntry | undefined;
}): void => {
  const apply = deps.applyDeferredObjectiveChange;
  if (!apply) return;
  apply({
    deviceId: params.device.id,
    deviceName: params.device.name ?? null,
    prevEntry: params.prevEntry,
    nextEntry: params.nextEntry,
    nowMs: deps.getNow().getTime(),
  });
};

function registerClearDeadlineCard(
  deps: FlowCardDeps,
  lastFlowStatusByDeviceId: Map<string, LastSmartTaskFlowStatus>,
): void {
  const card = deps.homey.flow.getActionCard('clear_deadline');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) throw new Error('Device must be provided.');
    const accessors = requireSettingsAccessors(deps);
    const settings = accessors.read();
    const prevEntry = settings.objectivesByDeviceId[deviceId];
    accessors.write(removeObjective(settings, deviceId));
    deps.getDeferredObjectiveStatusBus?.()?.forgetDevice(deviceId);
    deps.getDeferredObjectiveHoursRemainingTracker?.()?.forgetDevice(deviceId);
    // Drop the trigger's per-device suppression cache so a later re-added task
    // is treated as a fresh observation rather than continuing stale prior
    // status or hours-remaining comparisons.
    lastFlowStatusByDeviceId.delete(deviceId);
    deps.applyDeferredObjectiveChange?.({
      deviceId,
      deviceName: prevEntry ? await resolveDeviceName(deps, deviceId) : null,
      prevEntry,
      nextEntry: undefined,
      nowMs: deps.getNow().getTime(),
    });
    deps.rebuildPlan('deadline_objective_card_clear');
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    const settings = requireSettingsAccessors(deps).read();
    const activeIds = new Set(Object.keys(settings.objectivesByDeviceId));
    const candidates = activeIds.size > 0
      ? snapshot.filter((device) => activeIds.has(device.id))
      : snapshot;
    return buildDeviceAutocompleteOptions(candidates, query);
  });
}

function registerDeadlineStatusChangedTrigger(
  deps: FlowCardDeps,
  lastFlowStatusByDeviceId: Map<string, LastSmartTaskFlowStatus>,
): void {
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

  const bus = deps.getDeferredObjectiveStatusBus?.();
  if (!bus) return;
  bus.onTransition((snapshot) => {
    if (snapshot.deadlineMissed) return;
    const flowStatus = mapSnapshotToFlowStatus(snapshot);
    const previousStatus = resolvePreviousFlowStatus(snapshot, lastFlowStatusByDeviceId);
    // Always cache the latest status so future transitions have a comparison
    // point, even when we suppress this fire.
    lastFlowStatusByDeviceId.set(snapshot.deviceId, {
      status: flowStatus,
      deadlineAtMs: snapshot.deadlineAtMs,
    });
    // No prior status (first observation of a new task, or after `clear_deadline`
    // wiped the cache) is task creation, not a status change — don't fire.
    if (previousStatus === null) return;
    if (previousStatus === flowStatus) return;
    let tokens: Record<string, unknown>;
    try {
      tokens = buildSmartTaskStatusTokens(snapshot, flowStatus);
    } catch (err) {
      deps.error('Failed to build deadline_status_changed tokens', err);
      return;
    }
    void card.trigger?.(tokens, { deviceId: snapshot.deviceId })
      .catch((err: Error) => deps.error('Failed to trigger deadline_status_changed', err));
  });
}

const resolvePreviousFlowStatus = (
  snapshot: DeferredObjectiveStatusSnapshot,
  lastFlowStatusByDeviceId: Map<string, LastSmartTaskFlowStatus>,
): SmartTaskActiveFlowStatus | null => {
  // Bus reports `'none'` whenever the device was forgotten (`forgetDevice`),
  // which happens from clear_deadline, transition sweeps, and runtime disable
  // paths. Only clear_deadline also clears `lastFlowStatusByDeviceId`, so the
  // cache may still hold a same-deadline entry from a prior fire. Trust the
  // bus's `'none'` signal first — otherwise a recreated/reappearing task
  // emits a spurious status-change trigger on its first observation.
  if (snapshot.previousStatus === 'none') return null;
  const previousFlowStatus = lastFlowStatusByDeviceId.get(snapshot.deviceId);
  // Cached entry for the same deadline is the highest-trust prior — it
  // reflects the last fired flow status, which may differ from the bus's
  // internal status mapping.
  if (previousFlowStatus?.deadlineAtMs === snapshot.deadlineAtMs) {
    return previousFlowStatus.status;
  }
  // Otherwise rely on the bus's reported previous internal status.
  return mapPreviousStatusToFlowStatus(snapshot.previousStatus);
};

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
      deps.error('Failed to build deadline_ended tokens', err);
      return;
    }
    void card.trigger?.(tokens, { deviceId: event.deviceId })
      .catch((err: Error) => deps.error('Failed to trigger deadline_ended', err));
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
    if (!event.allocationChanged) return;
    let tokens: Record<string, unknown>;
    try {
      tokens = buildSmartTaskPlanChangedTokens(event, deps.getTimeZone());
    } catch (err) {
      // Swallow listener-side errors so a malformed event cannot unwind back
      // into the plan-engine cycle that published it.
      deps.error('Failed to build deadline_plan_changed tokens', err);
      return;
    }
    void card.trigger?.(tokens, { deviceId: event.deviceId })
      .catch((err: Error) => deps.error('Failed to trigger deadline_plan_changed', err));
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
      deps.error('Failed to build smart_task_hours_remaining tokens', err);
      return;
    }
    void card.trigger?.(tokens, {
      deviceId: event.deviceId,
      hoursRemaining: event.hoursRemaining,
      previousHoursRemaining: event.previousHoursRemaining,
    }).catch((triggerErr: Error) => deps.error('Failed to trigger smart_task_hours_remaining', triggerErr));
  });
}

function registerDeadlineStatusIsCondition(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getConditionCard('deadline_status_is');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg; status?: DropdownArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) return false;
    const rawStatus = getDropdownId(payload?.status);
    const settings = requireSettingsAccessors(deps).read();
    const hasEntry = Boolean(settings.objectivesByDeviceId[deviceId]?.enabled);
    const legacyNoneMatch = isLegacyNoneStatusMatch(rawStatus, hasEntry);
    if (legacyNoneMatch !== null) return legacyNoneMatch;
    const wantedStatus = normalizeSmartTaskStatusArg(payload?.status);
    if (!wantedStatus) return false;
    const bus = deps.getDeferredObjectiveStatusBus?.();
    const current = bus?.getCurrent(deviceId) ?? null;
    const effectiveStatus = resolveEffectiveStatus(current, hasEntry);
    return effectiveStatus !== null && effectiveStatus === wantedStatus;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });
}

// Resolves what the user effectively sees as the current smart task status.
// Four cases:
//   1. Bus has a current snapshot AND deadline already missed → no active
//      status matches; the missed trigger is the right surface for that event.
//   2. Bus has a current snapshot → use the mapped flow status.
//   3. No bus snapshot AND task is enabled in settings → the planner has not
//      produced a horizon yet (e.g. waiting for prices); the user-facing
//      status is `waiting`.
//   4. Otherwise → no task; nothing matches.
const resolveEffectiveStatus = (
  current: DeferredObjectiveStatusSnapshot | null,
  hasEntry: boolean,
): SmartTaskActiveFlowStatus | null => {
  if (current) {
    if (current.deadlineMissed) return null;
    return mapSnapshotToFlowStatus(current);
  }
  if (hasEntry) return PENDING_FLOW_STATUS;
  return null;
};

function registerHasActiveDeadlineCondition(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getConditionCard('has_active_deadline');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) return false;
    const settings = requireSettingsAccessors(deps).read();
    return Boolean(settings.objectivesByDeviceId[deviceId]?.enabled);
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });
}
