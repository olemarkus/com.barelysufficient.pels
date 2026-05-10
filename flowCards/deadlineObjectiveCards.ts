import {
  normalizeDeferredObjectiveSettings,
  type DeferredObjectiveSettingsEntry,
  type DeferredObjectiveSettingsV1,
  type DeferredObjectiveStatus,
  type DeferredObjectiveStatusSnapshot,
} from '../lib/plan/deferredObjectives';
import { DEFERRED_OBJECTIVES_SETTINGS } from '../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../lib/utils/types';
import { buildDeviceAutocompleteOptions, getDeviceIdFromFlowArg, type RawFlowDeviceArg } from './deviceArgs';
import type { FlowCardDeps } from './registerFlowCards';

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const TRIGGER_STATUS_VALUES = new Set([
  'on_track',
  'at_risk',
  'cannot_meet',
  'satisfied',
] as const);
type TriggerStatusValue = 'on_track' | 'at_risk' | 'cannot_meet' | 'satisfied';

type DropdownArg = string | { id?: string; name?: string };

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

const buildTriggerTokens = (snapshot: DeferredObjectiveStatusSnapshot): Record<string, unknown> => ({
  device_name: snapshot.deviceName ?? snapshot.deviceId,
  status: snapshot.status,
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
    const accessors = requireSettingsAccessors(deps);
    const settings = accessors.read();
    accessors.write(upsertObjective(settings, deviceId, {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC,
      deadlineLocalTime,
    }));
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
    const enforcementId = getDropdownId(payload?.enforcement) || 'soft';
    if (enforcementId !== 'soft' && enforcementId !== 'hard') {
      throw new Error('Enforcement must be "soft" or "hard".');
    }
    const accessors = requireSettingsAccessors(deps);
    const settings = accessors.read();
    accessors.write(upsertObjective(settings, deviceId, {
      enabled: true,
      kind: 'ev_soc',
      enforcement: enforcementId,
      targetPercent,
      deadlineLocalTime,
    }));
    deps.rebuildPlan('deadline_objective_card_set');
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot.filter(isEvCharger), query);
  });
}

function registerClearDeadlineCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard('clear_deadline');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) throw new Error('Device must be provided.');
    const accessors = requireSettingsAccessors(deps);
    const next = removeObjective(accessors.read(), deviceId);
    accessors.write(next);
    deps.getDeferredObjectiveStatusBus?.()?.forgetDevice(deviceId);
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
  card.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg; status?: DropdownArg } | null;
    const stateRecord = (state ?? {}) as { deviceId?: string; status?: string };
    const wantedDeviceId = getDeviceIdFromFlowArg(payload?.device);
    const wantedStatus = getDropdownId(payload?.status);
    if (!wantedDeviceId || wantedDeviceId !== stateRecord.deviceId) return false;
    if (!wantedStatus || wantedStatus !== stateRecord.status) return false;
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot, query);
  });

  const bus = deps.getDeferredObjectiveStatusBus?.();
  if (!bus) return;
  bus.onTransition((snapshot) => {
    if (!TRIGGER_STATUS_VALUES.has(snapshot.status as TriggerStatusValue)) return;
    void card.trigger?.(buildTriggerTokens(snapshot), { deviceId: snapshot.deviceId, status: snapshot.status })
      .catch((err: Error) => deps.error('Failed to trigger deadline_status_changed', err));
  });
}

function registerDeadlineMissedTrigger(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getTriggerCard('deadline_missed');
  card.registerRunListener(async (args: unknown, state?: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg } | null;
    const stateRecord = (state ?? {}) as { deviceId?: string };
    const wantedDeviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!wantedDeviceId || wantedDeviceId !== stateRecord.deviceId) return false;
    return true;
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

function registerDeadlineStatusIsCondition(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getConditionCard('deadline_status_is');
  card.registerRunListener(async (args: unknown) => {
    const payload = args as { device?: RawFlowDeviceArg; status?: DropdownArg } | null;
    const deviceId = getDeviceIdFromFlowArg(payload?.device);
    if (!deviceId) return false;
    const wantedStatus = getDropdownId(payload?.status) as DeferredObjectiveStatus;
    const bus = deps.getDeferredObjectiveStatusBus?.();
    const current = bus?.getCurrent(deviceId) ?? null;
    const settings = requireSettingsAccessors(deps).read();
    const hasEntry = Boolean(settings.objectivesByDeviceId[deviceId]?.enabled);
    if (wantedStatus === 'none') return !hasEntry;
    return current?.status === wantedStatus;
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
