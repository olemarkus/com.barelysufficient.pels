import { isUnknownRecord } from '../recordGuards';

export const INVERTER_CURTAILMENT_DEVICES = 'inverter_curtailment_devices';
/** Explicit opt-in per inverter; absent entries are off. */
export type InverterCurtailmentDevices = Readonly<Record<string, boolean>>;

export function parseInverterCurtailmentDevices(value: unknown): InverterCurtailmentDevices | null {
  if (!isUnknownRecord(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, boolean] => (
    entry[0].length > 0 && typeof entry[1] === 'boolean'
  ))) return null;
  return Object.fromEntries(entries);
}

/** An absent entry is off; control always needs an explicit opt-in. */
export const isInverterCurtailmentEnabled = (devices: InverterCurtailmentDevices, deviceId: string): boolean => (
  devices[deviceId] === true
);
