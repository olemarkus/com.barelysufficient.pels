import { isUnknownRecord } from '../recordGuards';

export type DeviceBinarySwitches = Readonly<Record<string, string>>;

/** Homey on/off capabilities have standard boolean switch semantics. */
export const isBinarySwitchCapability = (id: string): boolean => /^onoff(?:\.[a-zA-Z0-9_-]+)*$/.test(id);

export function readDeviceBinarySwitches(value: unknown): DeviceBinarySwitches | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const entries: [string, string][] = [];
  for (const [deviceId, id] of Object.entries(value)) {
    if (deviceId.trim() === '' || typeof id !== 'string' || !isBinarySwitchCapability(id)) return undefined;
    entries.push([deviceId, id]);
  }
  return Object.fromEntries(entries);
}
