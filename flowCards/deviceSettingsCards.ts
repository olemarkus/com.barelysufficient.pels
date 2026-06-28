import { BUDGET_EXEMPT_DEVICES, CONTROLLABLE_DEVICES } from '../lib/utils/settingsKeys';
import { isObserveOnlyRoleClassKey } from '../lib/device/transport/managerHelpers';
import { formatDeviceMustBeProvidedMessage } from '../packages/shared-domain/src/smartTaskRescueStrings';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { FlowCardDeps } from './registerFlowCards';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import { readFlowDeviceArg } from './flowArgParsers';

// An OBSERVE-ONLY device (a home battery / solar device) is auto-tracked but is NOT a
// user-facing device: PELS never controls it and it carries no managed-load semantics, so
// it must never be OFFERED in a device picker. Letting a user pick one would either write
// an inconsistent, no-op settings row (capacity-control / budget-exemption) or expose an
// internal-only device in a condition card. Every device-arg autocomplete (and every write
// that takes one) filters on this predicate so the picker offers only genuinely eligible
// devices.
//
// Keyed on the observe-only ROLE (`deviceClass` is 'battery'/'solarpanel'), NOT on the
// device's CURRENT `controllable`/`managed` flags: a normal device the user has not yet
// opted in is legitimately `controllable: false` right now, and the capacity-control card
// is exactly the path to flip it on — filtering on a live flag would block that real enable
// flow. The role is the immutable signal that the device is observe-only forever.
const isUserSelectableDevice = (device: TargetDeviceSnapshot): boolean => (
  !isObserveOnlyRoleClassKey(device.deviceClass)
);

export function registerDeviceCapacityControlCards(deps: FlowCardDeps): void {
  registerDeviceBooleanActionCard({
    cardId: 'enable_device_capacity_control',
    enabled: true,
    settingKey: CONTROLLABLE_DEVICES,
    label: 'capacity control',
    settingKind: 'capacity_control',
    deviceFilter: isUserSelectableDevice,
    deps,
  });
  registerDeviceBooleanActionCard({
    cardId: 'disable_device_capacity_control',
    enabled: false,
    settingKey: CONTROLLABLE_DEVICES,
    label: 'capacity control',
    settingKind: 'capacity_control',
    deviceFilter: isUserSelectableDevice,
    deps,
  });
}

export function registerBudgetExemptionCards(deps: FlowCardDeps): void {
  registerDeviceBooleanActionCard({
    cardId: 'add_budget_exemption',
    enabled: true,
    settingKey: BUDGET_EXEMPT_DEVICES,
    label: 'budget exemption',
    settingKind: 'budget_exemption',
    deviceFilter: isUserSelectableDevice,
    deps,
  });
  registerDeviceBooleanActionCard({
    cardId: 'remove_budget_exemption',
    enabled: false,
    settingKey: BUDGET_EXEMPT_DEVICES,
    label: 'budget exemption',
    settingKind: 'budget_exemption',
    deviceFilter: isUserSelectableDevice,
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
  settingKind: string;
  // Optional eligibility filter. When present, the autocomplete only offers — and the
  // write only acts on — devices that pass it. Used by the capacity-control cards to keep
  // observe-only devices (battery / solar, `controllable: false`) out of the picker.
  deviceFilter?: (device: TargetDeviceSnapshot) => boolean;
  deps: FlowCardDeps;
}): void {
  const { cardId, deps, deviceFilter, ...settingParams } = params;
  const card = deps.homey.flow.getActionCard(cardId);
  card.registerRunListener(async (args: unknown) => {
    await setDeviceBooleanSetting({
      deviceId: readFlowDeviceArg(args),
      deps,
      deviceFilter,
      ...settingParams,
    });
    return true;
  });
  card.registerArgumentAutocompleteListener(
    'device',
    async (query: string) => getDeviceOptions(deps, query, deviceFilter),
  );
}

function registerDeviceSnapshotCondition(params: {
  cardId: string;
  predicate: (device: TargetDeviceSnapshot) => boolean;
  deps: FlowCardDeps;
}): void {
  const { cardId, predicate, deps } = params;
  const card = deps.homey.flow.getConditionCard(cardId);
  // The run listener answers truthfully for whatever device the flow references — an
  // observe-only battery genuinely IS `managed` internally, so an existing flow that
  // already points at one keeps evaluating correctly. We only keep observe-only devices
  // out of the AUTOCOMPLETE so they are never offered as a new pick (the "hide fully"
  // contract), without silently breaking a flow a user built before the filter landed.
  card.registerRunListener(async (args: unknown) => {
    const device = await resolveDeviceFromArgs(args, deps);
    return device ? predicate(device) : false;
  });
  card.registerArgumentAutocompleteListener(
    'device',
    async (query: string) => getDeviceOptions(deps, query, isUserSelectableDevice),
  );
}

async function resolveDeviceFromArgs(args: unknown, deps: FlowCardDeps): Promise<TargetDeviceSnapshot | null> {
  const deviceId = readFlowDeviceArg(args);
  if (!deviceId) return null;
  const snapshot = await deps.getSnapshot();
  return snapshot.find((device) => device.id === deviceId) ?? null;
}

async function getDeviceOptions(
  deps: FlowCardDeps,
  query: string,
  deviceFilter?: (device: TargetDeviceSnapshot) => boolean,
): Promise<Array<{ id: string; name: string }>> {
  const snapshot = await deps.getSnapshot();
  const eligible = deviceFilter ? snapshot.filter(deviceFilter) : snapshot;
  return buildDeviceAutocompleteOptions(eligible, query);
}

async function setDeviceBooleanSetting(params: {
  deviceId: string;
  enabled: boolean;
  settingKey: string;
  label: string;
  settingKind: string;
  deviceFilter?: (device: TargetDeviceSnapshot) => boolean;
  deps: FlowCardDeps;
}): Promise<void> {
  const {
    deviceId,
    enabled,
    settingKey,
    label,
    settingKind,
    deviceFilter,
    deps,
  } = params;
  if (!deviceId) throw new Error(formatDeviceMustBeProvidedMessage(label));
  const snapshot = await deps.getSnapshot();
  const device = snapshot.find((entry) => entry.id === deviceId);
  const deviceName = device ? device.name : null;
  // Skip the write for an ineligible device (e.g. an observe-only battery/solar device
  // hand-picked via a stale flow arg): it would only persist a no-op, inconsistent
  // settings row. Log the skip so the user-facing flow still has a trace.
  if (device && deviceFilter && !deviceFilter(device)) {
    deps.getStructuredLogger('devices')?.info({
      event: 'device_setting_toggle_skipped',
      setting: settingKind,
      reasonCode: 'device_not_eligible',
      deviceId,
      deviceName,
    });
    return;
  }
  const existing = deps.homey.settings.get(settingKey);
  const next = {
    ...getBooleanSettingsRecord(existing),
    [deviceId]: enabled,
  };
  deps.homey.settings.set(settingKey, next);
  deps.getStructuredLogger('devices')?.info({
    event: 'device_setting_toggled',
    setting: settingKind,
    enabled,
    deviceId,
    deviceName,
  });
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
