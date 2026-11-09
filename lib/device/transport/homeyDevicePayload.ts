import { isUnknownRecord } from '../../../packages/shared-domain/src/recordGuards';
import type { HomeyDeviceLike } from '../../utils/types';

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const recordOrNull = (value: unknown): Record<string, unknown> | null => (isUnknownRecord(value) ? value : null);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isStringList = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
);
const resolveOwnerUri = (payload: Record<string, unknown>): unknown => (
  isNonEmptyString(payload.ownerUri) ? payload.ownerUri : payload.driverUri
);

/**
 * The boundary for a device read from Homey. Homey's payload has two shapes:
 * `ownerUri` with a qualified `driverId`, and an older one with only `driverUri`
 * (the same value under its old name) and a local `driverId`. Both leave here as
 * the first, so no consumer sees the difference.
 *
 * A device is dropped only when PELS cannot tell what it is or read its
 * capabilities. Other fields are descriptive: one that is missing or malformed
 * resolves to its empty form and leaves the device usable.
 */
export function parseHomeyDevicePayload(value: unknown): HomeyDeviceLike | null {
  if (!isUnknownRecord(value)) return null;
  const { id, name, class: deviceClass, driverId, available, capabilities, capabilitiesObj } = value;
  const ownerUri = resolveOwnerUri(value);
  if (typeof id !== 'string' || typeof name !== 'string' || typeof deviceClass !== 'string') return null;
  if (!isNonEmptyString(driverId) || !isNonEmptyString(ownerUri) || typeof available !== 'boolean') return null;
  if (!isStringList(capabilities) || !isUnknownRecord(capabilitiesObj)) return null;
  return {
    ...value,
    id,
    name,
    class: deviceClass,
    ownerUri,
    driverId: driverId.includes(':') ? driverId : `${ownerUri}:${driverId}`,
    available,
    capabilities,
    capabilitiesObj: capabilitiesObj as HomeyDeviceLike['capabilitiesObj'],
    data: recordOrNull(value.data) ?? {},
    settings: recordOrNull(value.settings) ?? {},
    energy: recordOrNull(value.energy),
    energyObj: recordOrNull(value.energyObj),
    virtualClass: stringOrNull(value.virtualClass),
    unavailableMessage: stringOrNull(value.unavailableMessage),
    ready: typeof value.ready === 'boolean' ? value.ready : null,
    zone: stringOrNull(value.zone) ?? '',
  };
}
