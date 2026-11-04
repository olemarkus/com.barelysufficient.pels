import type { EvObservedFields, EvObservedProbe } from '../../contracts/src/types';
import { isEvDevice, type EvDeviceIdentity } from './evPlugState';

/**
 * Narrow an EV snapshot only when the transport has accepted a plug-state.
 * Charger identity survives an unreadable field; it does not prove a connected,
 * disconnected or charging session. Consumers needing identity use isEvDevice.
 * Use this guard only on carriers that still contain observed state, never a
 * plan device whose producer has already resolved the observation into facts.
 */
export const isEvObserved = <T extends EvDeviceIdentity & EvObservedProbe>(
  snapshot: T,
): snapshot is T & EvObservedFields => isEvDevice(snapshot) && snapshot.evChargingState !== undefined;
