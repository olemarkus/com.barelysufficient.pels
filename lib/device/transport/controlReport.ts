import { isFiniteNumber } from '../../../packages/shared-domain/src/numberGuards';
import { hasObservedTemperature } from '../../../packages/shared-domain/src/temperatureObservedState';
import type { ControlReported } from '../../ports/controlContest';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { normalizeRealtimeCapabilityEventValue } from './realtimeCapabilityShared';

/**
 * Owner: transport. The device's own report of its switch or setpoint, for the
 * executor's control contest record (`lib/executor/controlContest.ts`): the
 * binary control capability's value, or the primary temperature target's,
 * normalized as the snapshot reads it. The caller passes only events that are
 * not Homey's echo of PELS's write. Undefined for any other capability, or for
 * a value the transport does not read.
 */
export function resolveControlReport(
  snapshot: TransportDeviceSnapshot,
  capabilityId: string,
  value: unknown,
  reportedAtMs: number,
): ControlReported | undefined {
  const deviceId = snapshot.id;
  if (capabilityId === snapshot.binaryCapabilityId) {
    return typeof value === 'boolean' ? { deviceId, setting: 'on_off', value, reportedAtMs } : undefined;
  }
  if (!hasObservedTemperature(snapshot) || capabilityId !== snapshot.temperature.target.id) return undefined;
  const normalized = normalizeRealtimeCapabilityEventValue(capabilityId, value);
  return isFiniteNumber(normalized) ? { deviceId, setting: 'temperature', value: normalized, reportedAtMs } : undefined;
}
