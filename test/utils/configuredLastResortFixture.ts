import { ignoredDeviceJournal } from '../helpers/deviceJournalStub';
import { DeviceControlSettings } from '../../lib/device/deviceControlSettings';
import type { ConfiguredLastResortDevices } from '../../lib/ports/configuredLastResortDevices';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';

/**
 * The device-control owner over the same settings store, loaded the way the
 * app's startup settings step loads it, as the external-off owner reads it.
 */
export function configuredLastResortFrom(
  settings: Pick<SettingsPort, 'get' | 'getKeys'>,
): ConfiguredLastResortDevices {
  const owner = new DeviceControlSettings(settings, ignoredDeviceJournal);
  try {
    owner.reload();
  } catch {
    // A failed startup read leaves the owner without an answer, as in the app.
  }
  return {
    isConfigured: (id) => owner.isLastResortConfigured(id),
    read: () => owner.readConfiguredLastResortDevices(),
  };
}
