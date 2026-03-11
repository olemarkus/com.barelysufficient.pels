import { BUDGET_EXEMPT_DEVICES, CONTROLLABLE_DEVICES } from '../lib/utils/settingsKeys';
import type { TargetDeviceSnapshot } from '../lib/utils/types';
import type { FlowCardDeps } from './registerFlowCards';

type DeviceArg = string | { id?: string; name?: string; data?: { id?: string } };

export function registerDeviceCapacityControlCards(deps: FlowCardDeps): void {
  registerDeviceBooleanActionCard({
    cardId: 'enable_device_capacity_control',
    enabled: true,
    settingKey: CONTROLLABLE_DEVICES,
    label: 'capacity control',
    logPrefix: 'Flow: capacity control',
    deps,
  });
  registerDeviceBooleanActionCard({
    cardId: 'disable_device_capacity_control',
    enabled: false,
    settingKey: CONTROLLABLE_DEVICES,
    label: 'capacity control',
    logPrefix: 'Flow: capacity control',
    deps,
  });
}

export function registerBudgetExemptionCards(deps: FlowCardDeps): void {
  registerDeviceBooleanActionCard({
    cardId: 'add_budget_exemption',
    enabled: true,
    settingKey: BUDGET_EXEMPT_DEVICES,
    label: 'budget exemption',
    logPrefix: 'Flow: budget exemption',
    deps,
  });
  registerDeviceBooleanActionCard({
    cardId: 'remove_budget_exemption',
    enabled: false,
    settingKey: BUDGET_EXEMPT_DEVICES,
    label: 'budget exemption',
    logPrefix: 'Flow: budget exemption',
    deps,
  });
}

export function registerManagedDeviceCondition(deps: FlowCardDeps): void {
  registerDeviceSnapshotCondition({
    cardId: 'is_device_managed',
    predicate: (device) => device.managed === true,
    deps,
  });
}

export function registerCapacityControlCondition(deps: FlowCardDeps): void {
  registerDeviceSnapshotCondition({
    cardId: 'is_device_capacity_controlled',
    predicate: (device) => device.controllable === true,
    deps,
  });
}

export function registerBudgetExemptionCondition(deps: FlowCardDeps): void {
  registerDeviceSnapshotCondition({
    cardId: 'is_device_budget_exempt',
    predicate: (device) => device.budgetExempt === true,
    deps,
  });
}

function registerDeviceBooleanActionCard(params: {
  cardId: string;
  enabled: boolean;
  settingKey: string;
  label: string;
  logPrefix: string;
  deps: FlowCardDeps;
}): void {
  const { cardId, deps, ...settingParams } = params;
  const card = deps.homey.flow.getActionCard(cardId);
  card.registerRunListener(async (args: unknown) => {
    await setDeviceBooleanSetting({
      payload: args as { device?: DeviceArg } | null,
      deps,
      ...settingParams,
    });
    return true;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => getDeviceOptions(deps, query));
}

function registerDeviceSnapshotCondition(params: {
  cardId: string;
  predicate: (device: TargetDeviceSnapshot) => boolean;
  deps: FlowCardDeps;
}): void {
  const { cardId, predicate, deps } = params;
  const card = deps.homey.flow.getConditionCard(cardId);
  card.registerRunListener(async (args: unknown) => {
    const device = await resolveDeviceFromArgs(args, deps);
    return device ? predicate(device) : false;
  });
  card.registerArgumentAutocompleteListener('device', async (query: string) => getDeviceOptions(deps, query));
}

async function resolveDeviceFromArgs(args: unknown, deps: FlowCardDeps): Promise<TargetDeviceSnapshot | null> {
  const payload = args as { device?: DeviceArg } | null;
  const deviceId = getDeviceIdFromArg(payload?.device as DeviceArg);
  if (!deviceId) return null;
  const snapshot = await deps.getSnapshot();
  return snapshot.find((device) => device.id === deviceId) ?? null;
}

async function getDeviceOptions(deps: FlowCardDeps, query: string): Promise<Array<{ id: string; name: string }>> {
  const normalizedQuery = (query || '').toLowerCase();
  const snapshot = await deps.getSnapshot();
  return snapshot
    .map((device) => ({ id: device.id, name: device.name || device.id }))
    .filter((device) => !normalizedQuery || device.name.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getDeviceIdFromArg(arg: DeviceArg): string {
  const deviceIdRaw = typeof arg === 'object' && arg !== null
    ? arg.id || arg.data?.id
    : arg;
  return (deviceIdRaw || '').trim();
}

async function setDeviceBooleanSetting(params: {
  payload: { device?: DeviceArg } | null;
  enabled: boolean;
  settingKey: string;
  label: string;
  logPrefix: string;
  deps: FlowCardDeps;
}): Promise<void> {
  const {
    payload,
    enabled,
    settingKey,
    label,
    logPrefix,
    deps,
  } = params;
  const deviceId = getDeviceIdFromArg(payload?.device as DeviceArg);
  if (!deviceId) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} device must be provided`);
  const snapshot = await deps.getSnapshot();
  const deviceName = snapshot.find((device) => device.id === deviceId)?.name || deviceId;
  const existing = deps.homey.settings.get(settingKey);
  const next = {
    ...getBooleanSettingsRecord(existing),
    [deviceId]: enabled,
  };
  deps.homey.settings.set(settingKey, next);
  deps.log(`${logPrefix} ${enabled ? 'enabled' : 'disabled'} for ${deviceName}`);
}

function getBooleanSettingsRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return {};
  const entries = Object.entries(record);
  if (!entries.every(([key, entry]) => typeof key === 'string' && typeof entry === 'boolean')) return {};
  return record as Record<string, boolean>;
}
