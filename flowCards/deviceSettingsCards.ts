import { BUDGET_EXEMPT_DEVICES, CONTROLLABLE_DEVICES } from '../lib/utils/settingsKeys';
import { formatDeviceMustBeProvidedMessage } from '../packages/shared-domain/src/smartTaskRescueStrings';
import type { DeviceDescriptorRead } from '../packages/contracts/src/types';
import type { FlowCardDeps } from './registerFlowCards';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import { isHomeBatteryClassKey } from '../packages/shared-domain/src/batteryOrSolarRole';
import { isBatteryPowerLimitEnabled } from '../packages/shared-domain/src/settings/batteryPowerLimit';
import { readFlowDeviceArg } from './flowArgParsers';

// A home battery or solar device is never offered in these device pickers. A
// solar device is not a user-facing device at all. A home battery is, but its
// Managed switch is its own setting (`battery_control_devices`), and the
// budget-exemption setting does not apply to it. The capacity-control cards are
// the exception: a battery's Power-limit control lives in `controllable_devices`
// like a load's (`isBatteryPowerLimitEnabled`), so those cards, and the
// capacity-control condition, accept it (`isCapacityControlDevice`); the
// enable card, and a true answer from the condition, only while PELS can
// drive it.
//
// Keyed on the device's ROLE (`deviceClass` is 'battery'/'solarpanel'), NOT on
// its CURRENT `controllable`/`managed` flags: a normal device the user has not
// yet opted in is legitimately `controllable: false` right now, and the
// capacity-control card is exactly the path to flip it on — filtering on a live
// flag would block that real enable flow.
const isUserSelectableDevice = (device: DeviceDescriptorRead): boolean => (
  !device.isBatteryOrSolar
);

// A home battery: its Power-limit control is the capacity-control setting too.
const isHomeBattery = (device: DeviceDescriptorRead): boolean => isHomeBatteryClassKey(device.deviceClass);

// The devices the capacity-control cards may name: every user-selectable
// device, and a home battery.
const isCapacityControlDevice = (device: DeviceDescriptorRead): boolean => (
  isUserSelectableDevice(device) || isHomeBattery(device)
);

// The gate an action card applies to the device its Flow names, and — over the
// tracked devices — to what its picker offers, so the two cannot disagree. A Flow
// can name a device PELS does not track right now (removed from Homey, or outside
// the managed filter, since the Flow list is the runtime snapshot); the gate then
// sees `undefined`, and each card decides what writing its value for it means.
type DeviceWriteGate = (device: DeviceDescriptorRead | undefined) => boolean;

// The disable and budget-exemption cards record their value for an untracked
// device, as they always have; it takes effect if the device is tracked again.
// Disabling in particular must never depend on a successful lookup: it is how a
// booking Flow hands a device back, and a refusal would leave PELS controlling it.
const recordsForUntrackedDevice: DeviceWriteGate = (device) => (
  device === undefined || isUserSelectableDevice(device)
);

// Disabling capacity control records for an untracked device as above, and
// for a home battery: turning its Power-limit control off.
const mayRevokeCapacityControl: DeviceWriteGate = (device) => (
  device === undefined || isCapacityControlDevice(device)
);

// ENABLING capacity control grants control authority, so it requires a device PELS
// can actually limit. The transport only admits devices with positive support
// evidence; `powerCapable === false` refuses an enable while that evidence is
// absent. The planner independently requires a real per-device reading before
// granting command authority, so a Flow setting never substitutes for a meter.
// Refusing the write turns a silent failure into a logged `device_setting_toggle_skipped`.
//
// An UNTRACKED device is refused too: its eligibility cannot be resolved, and a
// grant written blind is exactly the write this gate exists to stop — an
// unsupported device outside the managed filter would come back marked
// controllable. A Flow arg is untrusted input, so an unresolvable one is a no-op.
// `getFlowSnapshot` refreshes an empty snapshot before answering, so this does not
// turn the boot window into a refusal. `!== false`, not `=== true`: a descriptor
// without the flag is not a verdict. A home battery is granted only while PELS
// can drive it (`readBatteryControl`): its limit is priced from its own storage
// reading, never a load's power support, and a battery PELS can only watch
// (mode-only, on/off, or its app refusing control) has no Power-limit control
// to turn on.
const buildMayGrantCapacityControl = (deps: FlowCardDeps): DeviceWriteGate => (device) => (
  device !== undefined && (
    isHomeBattery(device)
      ? deps.readBatteryControl(device.id) === 'drivable'
      : isUserSelectableDevice(device) && device.powerCapable !== false
  )
);

export function registerDeviceCapacityControlCards(deps: FlowCardDeps): void {
  registerDeviceBooleanActionCard({
    cardId: 'enable_device_capacity_control',
    enabled: true,
    settingKey: CONTROLLABLE_DEVICES,
    label: 'capacity control',
    settingKind: 'capacity_control',
    deviceFilter: buildMayGrantCapacityControl(deps),
    deps,
  });
  registerDeviceBooleanActionCard({
    cardId: 'disable_device_capacity_control',
    enabled: false,
    settingKey: CONTROLLABLE_DEVICES,
    label: 'capacity control',
    settingKind: 'capacity_control',
    deviceFilter: mayRevokeCapacityControl,
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
    deviceFilter: recordsForUntrackedDevice,
    deps,
  });
  registerDeviceBooleanActionCard({
    cardId: 'remove_budget_exemption',
    enabled: false,
    settingKey: BUDGET_EXEMPT_DEVICES,
    label: 'budget exemption',
    settingKind: 'budget_exemption',
    deviceFilter: recordsForUntrackedDevice,
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
    // A home battery's descriptor never reads controllable (the generic gate
    // vetoes it): its Power-limit control is its own gate on the runtime-held
    // map the planner reads, and like a load's it counts only while the battery
    // is managed, and only while PELS can drive it at all.
    predicate: (device) => (
      isHomeBattery(device)
        ? device.managed === true
          && deps.readBatteryControl(device.id) === 'drivable'
          && isBatteryPowerLimitEnabled(deps.getControllableDevices(), device.id)
        : device.controllable === true
    ),
    offers: isCapacityControlDevice,
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
  // Optional eligibility gate. When present, the autocomplete only offers — and the
  // write only acts on — devices that pass it. Used by the capacity-control cards to keep
  // solar devices, and devices PELS cannot limit, out of the picker.
  deviceFilter?: DeviceWriteGate;
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
  predicate: (device: DeviceDescriptorRead) => boolean;
  /** The devices the autocomplete offers; every user-selectable device unless a card says otherwise. */
  offers?: (device: DeviceDescriptorRead) => boolean;
  deps: FlowCardDeps;
}): void {
  const { cardId, predicate, offers = isUserSelectableDevice, deps } = params;
  const card = deps.homey.flow.getConditionCard(cardId);
  // The run listener answers truthfully for whatever device the flow references — a
  // battery's `managed` is its Managed toggle, so an existing flow that already
  // points at one keeps evaluating correctly. We only keep battery and solar devices
  // out of the AUTOCOMPLETE so they are never offered as a new pick (the "hide fully"
  // contract), without silently breaking a flow a user built before the filter landed.
  card.registerRunListener(async (args: unknown) => {
    const device = await resolveDeviceFromArgs(args, deps);
    return device ? predicate(device) : false;
  });
  card.registerArgumentAutocompleteListener(
    'device',
    async (query: string) => getDeviceOptions(deps, query, offers),
  );
}

// Descriptors, not the snapshot: these cards resolve a device to write a SETTING
// on it and to list what is selectable. Neither question is about what the device
// is currently doing.
async function resolveDeviceFromArgs(
  args: unknown,
  deps: FlowCardDeps,
): Promise<DeviceDescriptorRead | null> {
  const deviceId = readFlowDeviceArg(args);
  if (!deviceId) return null;
  const descriptors = await deps.getDeviceDescriptors();
  return descriptors.find((device) => device.id === deviceId) ?? null;
}

async function getDeviceOptions(
  deps: FlowCardDeps,
  query: string,
  deviceFilter?: (device: DeviceDescriptorRead) => boolean,
): Promise<Array<{ id: string; name: string }>> {
  const descriptors = await deps.getDeviceDescriptors();
  const eligible = deviceFilter ? descriptors.filter(deviceFilter) : descriptors;
  return buildDeviceAutocompleteOptions(eligible, query);
}

async function setDeviceBooleanSetting(params: {
  deviceId: string;
  enabled: boolean;
  settingKey: string;
  label: string;
  settingKind: string;
  deviceFilter?: DeviceWriteGate;
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
  const descriptors = await deps.getDeviceDescriptors();
  const device = descriptors.find((entry) => entry.id === deviceId);
  const deviceName = device ? device.name : null;
  // Skip the write for a device the gate refuses (e.g. a battery or solar
  // device hand-picked via a stale flow arg, or a device PELS cannot limit). The gate
  // also sees an untracked device and decides for itself what that means. Log the skip
  // so the user-facing flow still has a trace, naming which of the two it was.
  if (deviceFilter && !deviceFilter(device)) {
    deps.getStructuredLogger('devices')?.info({
      event: 'device_setting_toggle_skipped',
      setting: settingKind,
      reasonCode: device === undefined ? 'device_not_tracked' : 'device_not_eligible',
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
