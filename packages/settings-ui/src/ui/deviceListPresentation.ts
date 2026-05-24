import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { setTooltip } from './tooltips.ts';
import {
  supportsManagedDevice,
  supportsPowerDevice,
  supportsTemperatureDevice,
  isGrayStateDevice,
  requiresNativeWiringForActivation,
} from './deviceUtils.ts';
import { resolveDeviceClassLabel } from './deviceClassLabels.ts';
import { resolveManagedState, state } from './state.ts';
import type { RowDisabledReasons } from './deviceControlAvailability.ts';

export type DeviceGroup = {
  key: string;
  label: string;
  devices: TargetDeviceSnapshot[];
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

const buildDeviceAvailabilityChip = (device: TargetDeviceSnapshot): HTMLElement | null => {
  if (!isGrayStateDevice(device)) return null;
  return buildStateChip(
    device.available === false ? 'Unavailable' : 'Unknown',
    device.available === false
      ? 'Device is currently unavailable in Homey.'
      : 'Device state is unknown.',
  );
};

const buildBudgetExemptChip = (device: TargetDeviceSnapshot): HTMLElement | null => {
  if (state.budgetExemptMap[device.id] !== true && device.budgetExempt !== true) return null;
  return buildStateChip('Budget exempt', 'This device is excluded from daily budget limits.');
};

const buildFlowBackedChip = (device: TargetDeviceSnapshot): HTMLElement | null => {
  if (device.flowBacked !== true) return null;
  return buildStateChip(
    'Flow-backed',
    'PELS is using flow-reported state to support this existing Homey device.',
  );
};

export const appendDeviceStateChips = (container: HTMLElement, device: TargetDeviceSnapshot) => {
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
    Boolean(reason)
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

export const resolveDeviceManageability = (device: TargetDeviceSnapshot) => {
  const supportsTemperature = supportsTemperatureDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const supportsManage = supportsManagedDevice(supportsPower, supportsTemperature);
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

export const groupDevicesByClass = (devices: TargetDeviceSnapshot[]): DeviceGroup[] => {
  const groups = new Map<string, TargetDeviceSnapshot[]>();
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
