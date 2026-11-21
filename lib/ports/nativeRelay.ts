import type { NativeRelayMeter } from '../../packages/contracts/src/types';

/** A native, metered, absolute switch. Its binding is compared only within one device id. */
export type NativeRelayBinding = { binding: string; zwave: boolean };

/** The device owner resolves these from the binding and response of the actual OFF write. */
export type NativeRelayOffResult =
  | { acknowledged: true; relayBinding: string; unflaggedRelay?: true }
  | { acknowledged: false; reason: 'zwave_no_ack'; relayBinding: string; err: unknown };

type Received<T> = T & { receivedAtMs: number };

/** Observer-owned readings and source clocks for one native switch. */
export type RelayMeterObservation = {
    on: boolean;
    binaryAtMs: number;
    lastOpposingOnAtMs?: number;
    datedWatts?: Received<NonNullable<NativeRelayMeter['watts']>>;
    watts?: Received<NonNullable<NativeRelayMeter['watts']>>;
    energy?: Received<NonNullable<NativeRelayMeter['energy']>>;
};
