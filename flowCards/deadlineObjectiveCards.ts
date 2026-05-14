import {
  formatDeadlineLocalTime,
  normalizeDeferredObjectiveSettings,
  resolveDeferredObjectiveDeadline,
  type DeferredObjectivePlanRevisionEvent,
  type DeferredObjectiveSettingsEntry,
  type DeferredObjectiveSettingsV1,
  type DeferredObjectiveStatusSnapshot,
} from '../lib/plan/deferredObjectives';
import { DEFERRED_OBJECTIVES_SETTINGS } from '../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../lib/utils/types';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import type { FlowCardDeps } from './registerFlowCards';

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

type SmartTaskActiveFlowStatus =
  | 'waiting'
  | 'on_track'
  | 'at_risk'
  | 'unachievable'
  | 'satisfied';

type LastSmartTaskFlowStatus = {
  status: SmartTaskActiveFlowStatus;
  deadlineAtMs: number | null;
};

const SMART_TASK_STATUS_LABELS: Record<SmartTaskActiveFlowStatus, string> = {
  waiting: 'Waiting',
  on_track: 'On track',
  at_risk: 'At risk',
  unachievable: 'Cannot finish',
  satisfied: 'Satisfied',
};

type DropdownArg = string | { id?: string; name?: string };
type InternalTaskStatus =
  | DeferredObjectiveStatusSnapshot['status']
  | DeferredObjectiveStatusSnapshot['previousStatus'];

const getDropdownId = (raw: DropdownArg | undefined): string => (
  (typeof raw === 'object' && raw !== null ? raw.id : raw) ?? ''
).trim();

const supportsTemperatureObjective = (device: TargetDeviceSnapshot): boolean => (
  device.deviceType === 'temperature' || device.targets.length > 0
);

const isEvCharger = (device: TargetDeviceSnapshot): boolean => (
  device.deviceClass === 'evcharger'
);

const requireSettingsAccessors = (deps: FlowCardDeps): {
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

const upsertObjective = (
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

const isLegacyNoneStatusMatch = (
  deps: FlowCardDeps,
  deviceId: string,
  rawStatus: string,
): boolean | null => {
  if (rawStatus !== 'none') return null;
  const settings = requireSettingsAccessors(deps).read();
  return !settings.objectivesByDeviceId[deviceId]?.enabled;
};

const buildTriggerTokens = (
  snapshot: DeferredObjectiveStatusSnapshot,
  status: SmartTaskActiveFlowStatus,
): Record<string, unknown> => ({
  device_name: snapshot.deviceName ?? snapshot.deviceId,
  status: SMART_TASK_STATUS_LABELS[status],
  target_text: snapshot.targetText,
  deadline_local_time: snapshot.deadlineLocalTime,
  kind: snapshot.kind,
});

const buildMissedTokens = (snapshot: DeferredObjectiveStatusSnapshot): Record<string, unknown> => ({
  device_name: snapshot.deviceName ?? snapshot.deviceId,
  kind: snapshot.kind,
  target_text: snapshot.targetText,
  deadline_local_time: snapshot.deadlineLocalTime,
  shortfall_text: snapshot.shortfallText ?? '',
  shortfall_kwh: snapshot.shortfallKwh ?? 0,
});

export function registerDeadlineObjectiveCards(deps: FlowCardDeps): void {
  registerSetTemperatureDeadlineCard(deps);
  registerSetEvChargeDeadlineCard(deps);
  registerClearDeadlineCard(deps);
  registerDeadlineStatusChangedTrigger(deps);
  registerDeadlineMissedTrigger(deps);
  registerDeadlinePlanChangedTrigger(deps);
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
      enforcement?: DropdownArg;
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
    const legacyEnforcement = getDropdownId(payload?.enforcement);
    if (legacyEnforcement && legacyEnforcement !== 'soft' && legacyEnforcement !== 'hard') {
      throw new Error('Enforcement must be "soft" or "hard".');
    }
    const accessors = requireSettingsAccessors(deps);
    const settings = accessors.read();
    const prevEntry = settings.objectivesByDeviceId[deviceId];
    const nextEntry: DeferredObjectiveSettingsEntry = {
      enabled: true,
      kind: 'ev_soc',
      enforcement: legacyEnforcement === 'hard' ? 'hard' : 'soft',
      targetPercent,
      deadlineAtMs,
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

function registerClearDeadlineCard(deps: FlowCardDeps): void {
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

function registerDeadlineStatusChangedTrigger(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getTriggerCard('deadline_status_changed');
  const lastFlowStatusByDeviceId = new Map<string, LastSmartTaskFlowStatus>();
  card.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg; status?: DropdownArg } | null;
    const stateRecord = (state ?? {}) as { deviceId?: string; status?: DropdownArg };
    const wantedDeviceId = getDeviceIdFromFlowArg(payload?.device);
    const wantedStatus = normalizeSmartTaskStatusArg(payload?.status);
    const actualStatus = normalizeSmartTaskStatusArg(stateRecord.status);
    if (!wantedDeviceId || wantedDeviceId !== stateRecord.deviceId) return false;
    if (!wantedStatus || wantedStatus !== actualStatus) return false;
    return true;
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
    const previousFlowStatus = lastFlowStatusByDeviceId.get(snapshot.deviceId);
    let previousStatus: SmartTaskActiveFlowStatus | null;
    if (snapshot.previousStatus === 'none') {
      previousStatus = null;
    } else if (previousFlowStatus?.deadlineAtMs === snapshot.deadlineAtMs) {
      previousStatus = previousFlowStatus.status;
    } else {
      previousStatus = mapPreviousStatusToFlowStatus(snapshot.previousStatus);
    }
    if (previousStatus === flowStatus) return;
    lastFlowStatusByDeviceId.set(snapshot.deviceId, {
      status: flowStatus,
      deadlineAtMs: snapshot.deadlineAtMs,
    });
    void card.trigger?.(buildTriggerTokens(snapshot, flowStatus), { deviceId: snapshot.deviceId, status: flowStatus })
      .catch((err: Error) => deps.error('Failed to trigger deadline_status_changed', err));
  });
}

function registerDeadlineMissedTrigger(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getTriggerCard('deadline_missed');
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
  bus.onMissed((snapshot) => {
    void card.trigger?.(buildMissedTokens(snapshot), { deviceId: snapshot.deviceId })
      .catch((err: Error) => deps.error('Failed to trigger deadline_missed', err));
  });
}

const buildPlanChangedTokens = (
  event: DeferredObjectivePlanRevisionEvent,
  timeZone: string,
): Record<string, unknown> => {
  const { hours, energyNeededKWh } = event.revision;
  const finishAtMs = event.projectedFinishAtMs;
  return {
    device_name: event.deviceName ?? event.deviceId,
    remaining_kwh: Math.round(energyNeededKWh * 1000) / 1000,
    planned_hours: hours.length,
    projected_finish_local_time: finishAtMs === null ? '' : formatDeadlineLocalTime(finishAtMs, timeZone),
  };
};

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
      tokens = buildPlanChangedTokens(event, deps.getTimeZone());
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

function registerDeadlineStatusIsCondition(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getConditionCard('deadline_status_is');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg; status?: DropdownArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) return false;
    const rawStatus = getDropdownId(payload?.status);
    const legacyNoneMatch = isLegacyNoneStatusMatch(deps, deviceId, rawStatus);
    if (legacyNoneMatch !== null) return legacyNoneMatch;
    const wantedStatus = normalizeSmartTaskStatusArg(payload?.status);
    if (!wantedStatus) return false;
    const bus = deps.getDeferredObjectiveStatusBus?.();
    const current = bus?.getCurrent(deviceId) ?? null;
    const settings = requireSettingsAccessors(deps).read();
    const hasEntry = Boolean(settings.objectivesByDeviceId[deviceId]?.enabled);
    if (wantedStatus === 'waiting' && current === null) return hasEntry;
    if (!current) return false;
    if (current.deadlineMissed) return false;
    return mapSnapshotToFlowStatus(current) === wantedStatus;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });
}

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
