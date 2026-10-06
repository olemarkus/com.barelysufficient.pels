import { setTooltip } from './tooltips.ts';
import {
  supportsPowerDevice,
  supportsTemperatureDevice,
  isGrayStateDevice,
  requiresNativeWiringForActivation,
  type SettingsUiDeviceListItem,
} from './deviceUtils.ts';
import { PLAN_CARD_BUDGET_EXEMPT_CHIP_LABEL } from '../../../shared-domain/src/planCardGrammar.ts';
import { resolveDeviceClassLabel } from './deviceClassLabels.ts';
import {
  isBatteryControlReadable,
  resolveBatteryPowerLimitOn,
  resolveManagedState,
  state,
} from './state.ts';
import { isHomeBatteryClassKey } from '../../../shared-domain/src/batteryOrSolarRole.ts';
import { resolveBatteryUndrivableLine } from '../../../shared-domain/src/batteryControlCopy.ts';
import { LEGEND_ONLY_REASONS, type RowDisabledReasons } from './deviceControlAvailability.ts';

export type DeviceGroup = {
  key: string;
  label: string;
  devices: SettingsUiDeviceListItem[];
};

type GroupManagedState = 'all' | 'partial' | 'none';

const buildStateChip = (label: string, title: string): HTMLElement => {
  const chip = document.createElement('span');
  // Rebind to the canonical `.plan-chip` primitive (2026-05-24 chip
  // consolidation). `--muted` matches the legacy `chip--neutral` tonal
  // intent; `device-row__state-chip` keeps the row-local padding /
  // line-height override.
  chip.className = 'plan-chip plan-chip--muted device-row__state-chip';
  chip.dataset.tone = 'muted';
  chip.textContent = label;
  setTooltip(chip, title);
  return chip;
};

// The status vocabulary has no "Unknown" (notes/ui-terminology.md): a device
// whose state PELS cannot read is unavailable to it, the word the Overview uses.
const buildDeviceAvailabilityChip = (device: SettingsUiDeviceListItem): HTMLElement | null => {
  if (!isGrayStateDevice(device)) return null;
  return buildStateChip(
    'Unavailable',
    device.available === false
      ? 'Device is currently unavailable in Homey.'
      : 'PELS cannot read this device’s state right now.',
  );
};

// Same flag, same word as the overview card's chip, from the same constant, so
// the two surfaces cannot drift apart again the way "Always on" did. The
// tooltip stays list-local: this row has space for the fuller sentence.
const buildBudgetExemptChip = (device: SettingsUiDeviceListItem): HTMLElement | null => {
  if (state.budgetExemptMap[device.id] !== true && device.budgetExempt !== true) return null;
  return buildStateChip(PLAN_CARD_BUDGET_EXEMPT_CHIP_LABEL, 'This device is excluded from daily budget limits.');
};

const buildFlowBackedChip = (device: SettingsUiDeviceListItem): HTMLElement | null => {
  if (device.flowBacked !== true) return null;
  return buildStateChip(
    'Flow-backed',
    'PELS is using flow-reported state to support this existing Homey device.',
  );
};

export const appendDeviceStateChips = (container: HTMLElement, device: SettingsUiDeviceListItem) => {
  const chips = [
    buildDeviceAvailabilityChip(device),
    buildFlowBackedChip(device),
    buildBudgetExemptChip(device),
  ];
  chips.forEach((chip) => {
    if (chip) container.appendChild(chip);
  });
};

export const appendRedesignDisabledReasons = (
  container: HTMLElement,
  reasons: RowDisabledReasons,
) => {
  const uniqueReasons = Array.from(new Set(Object.values(reasons).filter((reason): reason is string => (
    // A reason true of a whole class of rows (on/off devices have no price
    // response; an unmanaged device has neither Limit nor Price) is stated once
    // in the "Explain" expander, so it is dropped from the per-row list rather
    // than repeated under every such device. What remains is about THIS device.
    typeof reason === 'string' && reason !== '' && !LEGEND_ONLY_REASONS.has(reason)
  ))));
  if (!uniqueReasons.length) return;

  const list = document.createElement('ul');
  list.className = 'pels-device-card__reasons';
  uniqueReasons.forEach((reason) => {
    const item = document.createElement('li');
    item.textContent = reason;
    list.appendChild(item);
  });
  container.appendChild(list);
};

export const resolveDeviceManageability = (device: SettingsUiDeviceListItem) => {
  // A home battery listed here is one PELS can manage (the runtime lists only
  // a Main-home battery), unless its Managed map does not parse: the runtime
  // then treats it as unmanaged, so the switch shows off and unavailable. Its
  // Limit switch is its Power-limit control, offered while it is managed and
  // only for a battery PELS can drive (`isLimitToggleOn`); one PELS can only
  // watch has none, and its row says why (`resolveBatteryRowReasons`). Price
  // has no temperature to act on, so it reads as not applicable.
  if (isHomeBatteryClassKey(device.deviceClass)) {
    const canManage = isBatteryControlReadable();
    return {
      supportsTemperature: false,
      supportsPower: device.batteryControl === 'drivable',
      supportsManage: true,
      nativeWiringRequired: false,
      canManage,
      isManaged: canManage && resolveManagedState(device.id),
    };
  }
  const supportsTemperature = supportsTemperatureDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const supportsManage = supportsPower || supportsTemperature;
  const nativeWiringRequired = requiresNativeWiringForActivation(device);
  const canManage = supportsManage && !nativeWiringRequired;
  return {
    supportsTemperature,
    supportsPower,
    supportsManage,
    nativeWiringRequired,
    canManage,
    isManaged: canManage && resolveManagedState(device.id),
  };
};

/**
 * The row's Limit switch. A battery reads `controllable_devices` through its
 * own gate (absent = on, off while unmanaged), never as a load's `=== true`.
 */
export const isLimitToggleOn = (
  device: SettingsUiDeviceListItem,
  manageability: ReturnType<typeof resolveDeviceManageability>,
): boolean => {
  if (isHomeBatteryClassKey(device.deviceClass)) {
    return manageability.supportsPower && resolveBatteryPowerLimitOn(device.id);
  }
  return manageability.supportsPower && state.controllableMap[device.id] === true;
};

/**
 * The device-list line for a battery whose Managed PELS turned off after the
 * owner changed its mode in the battery's own app: the device page's
 * takeover notice, in one line.
 */
const BATTERY_TAKEOVER_ROW_REASON = 'You changed its mode in the battery app. '
  + 'PELS leaves it alone until you turn on Managed.';

/**
 * A battery row's reason lines. With Managed off after a takeover, the
 * takeover notice; managed, why PELS cannot drive it, in place of a Limit
 * switch (`resolveBatteryUndrivableLine`). Price never applies to a battery.
 */
export const resolveBatteryRowReasons = (
  device: SettingsUiDeviceListItem,
  isManaged: boolean,
  reasons: RowDisabledReasons,
): RowDisabledReasons => ({
  managed: reasons.managed ?? (!isManaged && device.batteryTakenOver ? BATTERY_TAKEOVER_ROW_REASON : null),
  // Unmanaged, a battery's Limit waits on Managed alone, which the legend says once.
  limit: isManaged ? resolveBatteryUndrivableLine(device.batteryControl) : null,
  price: null,
});

/** The Limit cell's title for a battery PELS cannot drive, or `null` for one it can. */
export const resolveBatteryLimitTitle = (device: SettingsUiDeviceListItem): string | null => (
  isHomeBatteryClassKey(device.deviceClass) ? resolveBatteryUndrivableLine(device.batteryControl) : null
);

export const groupDevicesByClass = (devices: SettingsUiDeviceListItem[]): DeviceGroup[] => {
  const groups = new Map<string, SettingsUiDeviceListItem[]>();
  devices.forEach((device) => {
    const key = (device.deviceClass || 'other').trim().toLowerCase() || 'other';
    const bucket = groups.get(key) || [];
    bucket.push(device);
    groups.set(key, bucket);
  });
  return Array.from(groups.entries())
    .map(([key, items]) => ({
      key,
      label: resolveDeviceClassLabel(key),
      devices: items.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
};

export const countManagedInGroup = (group: DeviceGroup): { managed: number; manageable: number; total: number } => {
  let managed = 0;
  let manageable = 0;
  group.devices.forEach((device) => {
    const m = resolveDeviceManageability(device);
    if (m.canManage) manageable += 1;
    if (m.canManage && m.isManaged) managed += 1;
  });
  return { managed, manageable, total: group.devices.length };
};

export const resolveGroupManagedState = (counts: { managed: number; manageable: number }): GroupManagedState => {
  if (counts.manageable === 0 || counts.managed === 0) return 'none';
  if (counts.managed === counts.manageable) return 'all';
  return 'partial';
};
