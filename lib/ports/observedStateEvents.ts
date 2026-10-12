import type { ExternalTemperatureAdjustment } from '../../packages/contracts/src/temperatureAdjustment';
import type { ObservedDeviceState } from '../../packages/contracts/src/types';
import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';

/**
 * The observation events transport hands to observer, defined once for both.
 * Transport (`lib/device/`) produces them through the dispatcher it is
 * constructed with; observer (`lib/observer/observedStateEvents.ts`) owns the
 * emitter that fans them out. Neither layer may import the other, so the shapes
 * live here, where both can.
 */

/** One capability whose observed value changed. */
export type ObservedCapabilityChange = {
    capabilityId: string;
    /** The capability actually reported, when it differs from the control capability it moved. */
    observedCapabilityId?: string;
    previousValue: string;
    nextValue: string;
};

export type ObservedStateChangedEvent = {
    source: 'realtime_capability' | 'device_update';
    deviceId: string;
    observationSeq?: number;
    observedAtMs?: number;
    capabilityId?: string;
    observedCapabilityIds?: string[];
    measurePowerBecameSignificantlyPositive?: boolean;
    // The decided observed value transport's fresher-wins merge produced for
    // this device, attached once at the dispatch funnel so the observer
    // projection records the merged value rather than re-merging (Stage 4a of
    // the snapshot decomposition).
    observed?: ObservedDeviceState;
};

/** Batch payload for a full snapshot refresh: one entry per committed device. */
export type ObservedStateRefreshEvent = ObservedDeviceStateRefreshPayload;

export type ObservedControlStateChangedEvent = {
    deviceId: string;
    observationSeq?: number;
    observedAtMs?: number;
    name?: string;
    capabilityId?: string;
    changes?: ObservedCapabilityChange[];
};

/**
 * Dispatcher passed into `DeviceTransport` at construction time. Wiring builds
 * it against observer's `ObservedStateEmitter`, so whenever transport finishes
 * translating a Homey event, observer's emitter is the single source of truth
 * for the fan-out. Required at construction; specs build one through
 * `test/helpers/deviceTransportHarness.ts`.
 */
export type ObservedStateEmitterDispatcher = {
    observedStateChanged: (event: ObservedStateChangedEvent) => void;
    observedStateRefresh: (event: ObservedStateRefreshEvent) => void;
    observedControlStateChanged: (event: ObservedControlStateChangedEvent) => void;
    externalTemperatureAdjusted: (adjustment: ExternalTemperatureAdjustment) => void;
    /**
     * Push the gross PV generation reading (watts) into observer's
     * `ObservedHomePower` holder, or `null` when absent, stamped with its read
     * time. Transport resolves the scalar from a Homey SDK energy report. The
     * stamp is carried explicitly because the flow source's separate generation
     * reader rides a different clock, and the holder's consumers must be able
     * to tell a fresh reading from an abandoned one. It grosses up the
     * authoritative whole-home consumption for the managed/unmanaged split and
     * never reaches the hard-cap import path.
     */
    setGenerationW: (w: number | null, observedAtMs: number) => void;
};
