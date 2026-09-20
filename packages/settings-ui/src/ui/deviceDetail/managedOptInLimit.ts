import type { SettingsUiDeviceListItem } from '../deviceUtils.ts';
import { supportsPowerDevice } from '../deviceUtils.ts';
import { state } from '../state.ts';
import {
  createSerializedAsyncRunner,
  readRecordSettingStrict,
  writeFreshSetting,
} from './settingsWrite.ts';

/**
 * Turning Managed on also turns Limit on.
 *
 * Managed alone lets PELS plan around a device; only Limit lets it turn the
 * device down, which is what an owner marking a device Managed is there to get.
 * As two separate taps, every new device sat managed and unlimitable until the
 * owner found the second toggle, with nothing on the row to say the first had
 * not been enough.
 *
 * One thing stops it: a device with **no power reading**. Limit is not available
 * to such a device at all (the row says why), and the runtime demotes a stray
 * `true` anyway.
 *
 * An explicit `false` does NOT stop it, though it looks like an owner's opt-out.
 * The map cannot tell one from the other: when a device loses the capability
 * Limit needs, the runtime writes `false` over the owner's `true`
 * (`applyFalseOverrides`, `setup/appDeviceSupport.ts` — and only ever over a
 * `true`). Honouring that `false` later would leave precisely the owner who HAD
 * Limit on stuck with Managed-but-unlimitable once the device came back. So
 * managing a device always starts it limitable; the Limit toggle, in the same
 * row and already showing the result, is the opt-out.
 */
export type ManagedOptInLimit = 'enable' | 'leave';

export const resolveManagedOptInLimit = (
  device: SettingsUiDeviceListItem,
  controllableMap: Readonly<Record<string, boolean>>,
): ManagedOptInLimit => {
  if (!supportsPowerDevice(device)) return 'leave';
  // Already on: nothing to write.
  return controllableMap[device.id] === true ? 'leave' : 'enable';
};

const runSerializedLimitWrite = createSerializedAsyncRunner();

/**
 * Apply `resolveManagedOptInLimit` after the owner turned Managed on.
 *
 * `isStillWanted` is the caller's Managed-intent check, asked again at the last
 * moment the write can still be stopped: the fresh read below awaits, and an
 * owner who turns Managed back off meanwhile must not get Limit switched on for
 * a device they just let go of. The callers' own checks cannot cover that
 * window; they have already run by the time this is waiting on the store.
 */
export async function applyManagedOptInLimit(
  deviceId: string,
  refresh: () => void,
  isStillWanted: () => boolean,
): Promise<void> {
  const device = state.latestDevices.find((entry) => entry.id === deviceId);
  if (!device || resolveManagedOptInLimit(device, state.controllableMap) === 'leave') return;
  await runSerializedLimitWrite(async () => {
    if (!isStillWanted()) return;
    await writeFreshSetting<Record<string, boolean>>({
      key: 'controllable_devices',
      context: 'device list',
      logMessage: 'Failed to turn on power-limit control',
      toastMessage: 'Managed is on, but Limit could not be turned on. Turn it on from the device row.',
      fallbackValue: state.controllableMap,
      readFresh: readRecordSettingStrict<boolean>,
      mutate: (currentMap) => (
        !isStillWanted() || currentMap[deviceId] === true ? currentMap : { ...currentMap, [deviceId]: true }
      ),
      commit: (nextMap) => {
        state.controllableMap = nextMap;
        refresh();
      },
      rollback: refresh,
    });
  });
}
