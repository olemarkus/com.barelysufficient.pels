import { MAIN_HOME_ID } from '../../../../contracts/src/settingsKeys.ts';
import { isHomeBatteryClassKey } from '../../../../shared-domain/src/batteryOrSolarRole.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { getHomeIdForUiDevice } from '../homeScopeMembership.ts';
import { isHomeBatteryDeviceId, resolveManagedState, state } from '../state.ts';

/**
 * A home battery's place in the active mode's priority order, among the
 * devices PELS manages, or `null` when the loaded order is not Main's (a meter
 * area's catalog is open in Modes) or the battery is not managed.
 */
const resolveBatteryPriorityPosition = (
  deviceId: string,
): { rank: number; total: number; mode: string } | null => {
  if (state.loadedModeHomeId !== MAIN_HOME_ID || !resolveManagedState(deviceId)) return null;
  const managedIds = state.latestDevices
    .filter((device) => resolveManagedState(device.id) && getHomeIdForUiDevice(device.id) === MAIN_HOME_ID)
    .map((device) => device.id);
  const mode = state.activeMode;
  const order = state.modePriorityCatalog.getOrder(mode, managedIds, isHomeBatteryDeviceId);
  return { rank: order.getPriority(deviceId), total: managedIds.length, mode };
};

/**
 * The battery section of a battery's device page: the notice after the owner
 * took it over in its own app, and its place in the priority order. The
 * Managed switch itself is the shared one, moved in by the section layout.
 */
export const renderDeviceDetailBattery = (device: SettingsUiDeviceDetailItem | null): void => {
  if (!device || !isHomeBatteryClassKey(device.deviceClass)) return;
  const managed = resolveManagedState(device.id);
  const notice = document.getElementById('device-detail-battery-takeover-notice');
  if (notice) notice.hidden = managed || device.batteryTakenOver !== true;
  const position = resolveBatteryPriorityPosition(device.id);
  const row = document.getElementById('device-detail-battery-priority-row');
  if (row) row.hidden = position === null;
  const value = document.getElementById('device-detail-battery-priority-value');
  if (value && position) value.textContent = `${position.rank} of ${position.total} in ${position.mode}`;
  const hint = document.getElementById('device-detail-battery-priority-hint');
  if (hint && position) hint.textContent = resolveBatteryPriorityHint(position);
};

/**
 * What the battery's place means, true for where it is: only last in the list
 * does it cover the whole house before any device is limited.
 */
export const resolveBatteryPriorityHint = (position: { rank: number; total: number }): string => (
  position.rank === position.total
    ? 'Last in the list, it covers the whole house before any device is limited.'
    : 'Its place decides who it protects: the devices above it.'
);

/** The Managed switch's hint, for a battery: what turning it on lets PELS do. */
export const BATTERY_MANAGED_HINT = 'PELS takes it over to hold your limit or store spare solar, then hands it back.';
