import { BATTERY_CONTROL_DEVICES } from '../../../contracts/src/settingsKeys.ts';
import {
  parseBatteryControlDevices,
  type BatteryControlDevices,
} from '../../../shared-domain/src/settings/batteryControlDevices.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './deviceDetail/settingsWrite.ts';
import { state } from './state.ts';
import { showToast } from './toast.ts';

/**
 * Every battery Managed write, from the device list and the device page alike,
 * runs one at a time: each reads the map fresh and writes it back whole, so
 * two quick toggles that overlapped would let the second drop the first.
 */
const runSerializedBatteryManagedWrite = createSerializedAsyncRunner();

/**
 * Turning Managed on is the owner overruling a takeover, so the notice that
 * PELS turned it off goes with it; the device list refetched on the setting's
 * change (`settingsChangeRouter.ts`) then carries the runtime's own answer.
 */
const clearTakeoverNotice = (deviceId: string): void => {
  if (!state.latestDevices.some((device) => device.id === deviceId && device.batteryTakenOver)) return;
  state.latestDevices = state.latestDevices.map((device) => (
    device.id === deviceId ? { ...device, batteryTakenOver: false } : device
  ));
};

/**
 * Write a home battery's Managed toggle. A battery's Managed is its own
 * setting (`battery_control_devices`), not `managed_devices`: the runtime's
 * battery control owner applies it, handing back a battery the owner turns off
 * and adopting the battery's current mode when the owner turns it back on
 * after changing it in the battery's own app. Turning it on needs none of the
 * opt-in a load gets (control mode, Power-limit control).
 */
export const writeBatteryManaged = (
  deviceId: string,
  managed: boolean,
  context: string,
  commit: () => void,
  rollback: () => void,
): Promise<boolean> => runSerializedBatteryManagedWrite(async () => {
  // The switch is not offered while the stored map does not parse; a write
  // that still arrives (a stale render) is refused rather than guessing a map.
  const read = state.batteryControl;
  if (read.status !== 'resolved') {
    await showToast('Battery settings could not be read. Try again later.', 'warn');
    rollback();
    return false;
  }
  const next = await writeFreshSetting<BatteryControlDevices>({
    key: BATTERY_CONTROL_DEVICES,
    context,
    logMessage: 'Failed to update battery Managed',
    toastMessage: 'Failed to update the battery.',
    // The last good map, so a transient bridge miss never erases other batteries.
    fallbackValue: read.devices,
    // A stored value that does not parse is refused, never overwritten: a map
    // naming one battery would turn every other battery back on.
    readFresh: (value) => {
      const parsed = parseBatteryControlDevices(value);
      if (parsed === null) throw new Error('Battery settings could not be read.');
      return parsed;
    },
    mutate: (current) => ({ ...current, [deviceId]: managed }),
    commit: (committed) => {
      state.batteryControl = { status: 'resolved', devices: committed };
      if (managed) clearTakeoverNotice(deviceId);
      commit();
    },
    rollback,
  });
  return next !== null;
});
