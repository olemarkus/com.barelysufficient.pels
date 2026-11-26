import { isUnknownRecord } from '../recordGuards';

export const DEVICE_POWER_HISTORY_IMPORT = 'device_power_history_import';

const OUTCOMES = [
  'imported', 'already_learned', 'history_unavailable', 'source_changed', 'save_failed',
] as const;

export type DevicePowerHistoryImportOutcome = typeof OUTCOMES[number];
export type DevicePowerHistoryImportRequest = {
  kind: 'request';
  id: string;
  deviceId: string;
  sourceDeviceId: string;
};
export type DevicePowerHistoryImportMessage = DevicePowerHistoryImportRequest | {
  kind: 'result';
  id: string;
  outcome: DevicePowerHistoryImportOutcome;
};

const isId = (value: unknown): value is string => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value);
const isOutcome = (value: unknown): value is DevicePowerHistoryImportOutcome =>
  OUTCOMES.some((outcome) => outcome === value);

export function readDevicePowerHistoryImport(value: unknown): DevicePowerHistoryImportMessage | undefined {
  if (!isUnknownRecord(value) || typeof value.id !== 'string'
    || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.id)) return undefined;
  const { kind, id, deviceId, sourceDeviceId, outcome } = value;
  if (kind === 'result' && isOutcome(outcome)) return { kind, id, outcome };
  if (kind === 'request' && isId(deviceId) && isId(sourceDeviceId)) return { kind, id, deviceId, sourceDeviceId };
  return undefined;
}
