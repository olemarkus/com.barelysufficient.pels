import type { SettingsPort } from '../ports/homeyRuntime';
import { DEVICE_BINARY_SWITCHES } from '../utils/settingsKeys';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { readDeviceBinarySwitches, type DeviceBinarySwitches }
  from '../../packages/shared-domain/src/settings/deviceBinarySwitches';

export { readDevicePowerSources, type DevicePowerSources }
  from '../../packages/shared-domain/src/settings/devicePowerSources';

type SetupSettingsPort = Pick<SettingsPort, 'get' | 'getKeys'>;
const selectionFor = (switches: DeviceBinarySwitches, deviceId: string): string | undefined => (
  Object.hasOwn(switches, deviceId) ? switches[deviceId] : undefined
);

/** Holds accepted independent switch choices and advances a revision at each change. */
export class DeviceBinarySwitchSettings {
  private accepted: DeviceBinarySwitches = {};
  private readonly revisions = new Map<string, number>();
  private nextRevision = 0;

  constructor(private readonly settings: SetupSettingsPort) {}

  selection(deviceId: string): string | undefined { return selectionFor(this.accepted, deviceId); }
  revision(deviceId: string): number { return this.revisions.get(deviceId) ?? 0; }

  isCurrent(deviceId: string): boolean {
    const persisted = this.read();
    if (persisted === undefined) return this.revision(deviceId) === 0;
    return selectionFor(persisted, deviceId) === this.selection(deviceId);
  }

  reload(): void {
    const next = this.read();
    if (!next) return;
    const knownIds = new Set(Object.keys(this.accepted).concat(Object.keys(next)));
    for (const deviceId of knownIds) {
      if (selectionFor(next, deviceId) === this.selection(deviceId)) continue;
      this.nextRevision += 1;
      this.revisions.set(deviceId, this.nextRevision);
    }
    this.accepted = next;
  }

  private read(): DeviceBinarySwitches | undefined {
    try {
      const value = this.settings.get(DEVICE_BINARY_SWITCHES);
      if (value !== null && value !== undefined) return readDeviceBinarySwitches(value);
      const known = readSettingsKeyList(this.settings);
      return known.status === 'resolved' && !known.keys.includes(DEVICE_BINARY_SWITCHES) ? {} : undefined;
    } catch {
      return undefined;
    }
  }
}
