import { isUnknownRecord } from '../recordGuards';

/** A null entry explicitly adds a device using its own power source. */
export type DevicePowerSources = Readonly<Record<string, string | null>>;

export function readDevicePowerSources(value: unknown): DevicePowerSources | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const entries = Object.entries(value);
  const sockets = entries.flatMap(([, source]) => typeof source === 'string' ? [source] : []);
  if (new Set(sockets).size !== sockets.length) return undefined;
  if (!entries.every(([device, source]) => device.trim().length > 0
    && (source === null || (typeof source === 'string' && source.trim().length > 0
      && source !== device && !Object.hasOwn(value, source))))) return undefined;
  return Object.fromEntries(entries) as DevicePowerSources;
}
