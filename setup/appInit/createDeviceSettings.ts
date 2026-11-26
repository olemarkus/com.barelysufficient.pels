import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import { createDeferredDeviceJournal } from '../../lib/diagnostics/deviceEventStore';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import type { UserdataDatabase } from '../../lib/store/userdataDatabase';

export const createDeviceSettings = (
  settings: Pick<SettingsPort, 'get' | 'getKeys'>,
  getDatabase: () => UserdataDatabase,
): DeviceControlSettings => new DeviceControlSettings(settings, createDeferredDeviceJournal(getDatabase));
