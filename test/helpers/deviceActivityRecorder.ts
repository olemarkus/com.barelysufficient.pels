import { DeviceOverviewLogRecorder } from '../../lib/diagnostics/deviceActivityRecorder';
import { retainDeviceActivity } from '../../lib/diagnostics/deviceActivityHistory';
import type { SettingsUiDeviceActivityEntry } from '../../packages/contracts/src/settingsUi/devices';

export const createTestDeviceActivityRecorder = (): DeviceOverviewLogRecorder => {
  let entries: SettingsUiDeviceActivityEntry[] = [];
  return new DeviceOverviewLogRecorder({
    append: (newEntries, nowMs) => { entries = retainDeviceActivity([...newEntries, ...entries], nowMs); },
    read: (nowMs) => retainDeviceActivity(entries, nowMs),
  });
};
