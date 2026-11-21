import type { NativeRelayBinding, NativeRelayOffResult } from '../../ports/nativeRelay';
import { HomeyHttpStatusError } from '../../utils/homeyHttpStatusError';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';

const hasNativeRelayControl = (snapshot: TransportDeviceSnapshot): boolean => (
  snapshot.binaryControllable && snapshot.binaryCapabilityId === 'onoff'
  && !snapshot.isEvCharger && !snapshot.isBatteryOrSolar
  && !snapshot.steppedLoadProfile && !snapshot.pendingSteppedLoad
  && !snapshot.flowBackedCapabilityIds?.includes('onoff')
  && (snapshot.binaryWriteCapabilityId ?? 'onoff') === 'onoff'
);

export function resolveNativeRelayBinding(
  snapshot: TransportDeviceSnapshot | undefined,
  raw: HomeyDeviceLike | undefined,
): NativeRelayBinding | undefined {
  if (!snapshot || !raw || !hasNativeRelayControl(snapshot) || !raw.capabilities.includes('onoff')) return undefined;
  const measuresWatts = raw.capabilities.includes('measure_power');
  if (!measuresWatts && !raw.capabilities.includes('meter_power')) return undefined;
  return { binding: raw.driverId, zwave: raw.flags?.includes('zwave') === true, measuresWatts };
}

const NO_ACK = 'TRANSMIT_COMPLETE_NO_ACK';
const reportsNoAck = (message: string): boolean => message === NO_ACK || message.endsWith(`(${NO_ACK})`);

export async function writeNativeRelayOff(
  relay: NativeRelayBinding,
  write: () => Promise<unknown>,
): Promise<NativeRelayOffResult> {
  try {
    await write();
    return {
      acknowledged: true, relayBinding: relay.binding, ...(relay.zwave ? {} : { unflaggedRelay: true as const }),
    };
  } catch (err) {
    if (!(err instanceof HomeyHttpStatusError) || !err.errorFields.some(reportsNoAck)) throw err;
    return { acknowledged: false, reason: 'zwave_no_ack', relayBinding: relay.binding, err };
  }
}
