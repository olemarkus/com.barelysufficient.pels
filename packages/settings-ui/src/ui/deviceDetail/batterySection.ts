import { MAIN_HOME_ID } from '../../../../contracts/src/settingsKeys.ts';
import { isHomeBatteryClassKey } from '../../../../shared-domain/src/batteryOrSolarRole.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { getHomeIdForUiDevice } from '../homeScopeMembership.ts';
import {
  isHomeBatteryDeviceId, resolveBatteryPowerLimitOn, resolveManagedState, state,
} from '../state.ts';

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

/** The Power-limit control hint says what the switch lets PELS do to this kind of device. */
const syncPowerLimitHint = (isHomeBattery: boolean): void => {
  const loadHint = document.getElementById('device-detail-controllable-hint');
  if (loadHint) loadHint.hidden = isHomeBattery;
  const batteryHint = document.getElementById('device-detail-controllable-battery-hint');
  if (batteryHint) batteryHint.hidden = !isHomeBattery;
};

/**
 * A battery PELS cannot drive shows neither Power-limit control nor priority,
 * so the section says what it does show.
 */
const syncDrivableRows = (drivable: boolean): void => {
  const controllableRow = document.getElementById('device-detail-controllable-row');
  if (controllableRow) controllableRow.hidden = !drivable;
  const sectionHint = document.getElementById('device-detail-battery-section-hint');
  if (sectionHint) sectionHint.textContent = drivable ? 'Control and priority' : 'What PELS sees';
};

/**
 * The battery section of a battery's device page: the notice after the owner
 * took it over in its own app, and its place in the priority order. The
 * Managed and Power-limit control switches are the shared ones, moved in by
 * the section layout; only the Power-limit hint changes with the kind.
 *
 * A battery PELS cannot drive has no Power-limit control and its place
 * protects nothing, so both rows are hidden; its status card already says
 * why (`resolveBatteryUndrivableLine`). Every other page gets the switch row
 * back.
 */
export const renderDeviceDetailBattery = (device: SettingsUiDeviceDetailItem | null): void => {
  const isHomeBattery = isHomeBatteryClassKey(device?.deviceClass);
  syncPowerLimitHint(isHomeBattery);
  const drivable = !device || !isHomeBattery || device.batteryControl === 'drivable';
  syncDrivableRows(drivable);
  if (!device || !isHomeBattery) return;
  const managed = resolveManagedState(device.id);
  const notice = document.getElementById('device-detail-battery-takeover-notice');
  if (notice) notice.hidden = managed || !device.batteryTakenOver;
  const position = drivable ? resolveBatteryPriorityPosition(device.id) : null;
  const row = document.getElementById('device-detail-battery-priority-row');
  if (row) row.hidden = position === null;
  if (!position) return;
  const value = document.getElementById('device-detail-battery-priority-value');
  if (value) value.textContent = `${position.rank} of ${position.total} in ${position.mode}`;
  const hint = document.getElementById('device-detail-battery-priority-hint');
  if (hint) hint.textContent = resolveBatteryPriorityHint(position, resolveBatteryPowerLimitOn(device.id));
};

/**
 * What the battery's place means, true for where it is: only last in the list
 * does it cover the whole house before any device is limited, and only with
 * Power-limit control on does its place protect anything at all.
 */
export const resolveBatteryPriorityHint = (
  position: { rank: number; total: number },
  powerLimitOn: boolean,
): string => {
  if (!powerLimitOn) return 'Turn on Power-limit control to let it hold your limit when its turn comes.';
  return position.rank === position.total
    ? 'Last in the list, it covers the whole house before any device is limited.'
    : 'Devices below it are limited first, so it protects only those above it.';
};

/**
 * The Modes page note under a priority list holding a battery PELS can
 * drive: each such battery by name, with what its place in this list means
 * (`resolveBatteryPriorityHint`). `null` when the list holds none, so a
 * battery PELS can only watch gets no promise from its place.
 */
export const resolvePriorityBatteryNote = (orderedDeviceIds: readonly string[]): string | null => {
  const lines = orderedDeviceIds.flatMap((deviceId, index) => {
    const device = state.latestDevices.find((entry) => entry.id === deviceId);
    if (!device || !isHomeBatteryClassKey(device.deviceClass) || device.batteryControl !== 'drivable') return [];
    const hint = resolveBatteryPriorityHint(
      { rank: index + 1, total: orderedDeviceIds.length },
      resolveBatteryPowerLimitOn(deviceId),
    );
    return [`${formatDisplayDeviceName(device.name)}: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`];
  });
  return lines.length > 0 ? lines.join(' ') : null;
};

/** Show the Modes page note for the order on screen, or hide it when it has nothing to say. */
export const renderPriorityBatteryNote = (note: HTMLElement | null, orderedDeviceIds: readonly string[]): void => {
  if (!note) return;
  const text = resolvePriorityBatteryNote(orderedDeviceIds);
  /* eslint-disable no-param-reassign -- the Modes page's own note element */
  note.hidden = text === null;
  note.textContent = text ?? '';
  /* eslint-enable no-param-reassign */
};

/** The Managed switch's hint, for a battery PELS can drive: what turning it on lets PELS do. */
export const BATTERY_MANAGED_HINT = 'PELS takes it over to hold your limit or store spare solar, then hands it back.';

/** The Managed switch's hint, for a battery PELS can only watch. */
export const BATTERY_WATCH_MANAGED_HINT = 'PELS reads its power and charge level and shows it on the Overview.';
