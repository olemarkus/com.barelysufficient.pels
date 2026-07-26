/**
 * Construction seam for the device layer's read-only observation producers.
 *
 * All three share a shape: consulted from the successful-fetch and realtime
 * `device.update` seams, holding a small bounded state, surfacing what they see
 * as structured events, and never feeding an actuation path. Building them
 * together keeps the SDK leaf (`deviceTransport.ts`) free of their individual
 * construction details, and gives the three a single place to document that
 * shared contract.
 *
 * - `battery` — home-battery SoC + signed power (`batteryStateProducer.ts`)
 * - `solar` — PV production (`solarProductionProducer.ts`)
 * - `evCarLink` — EV car-to-charger correlation probe (`evCarLinkProducer.ts`)
 */
import { BatteryStateProducer } from './batteryStateProducer';
import { SolarProductionProducer } from './solarProductionProducer';
import type { EvCarLinkProducer } from './evCarLinkProducer';
import {
    createEvCarLinkProducer,
    type ChargerViewInput,
    type EvCarLinkSnapshotAccess,
} from './evCarLinkWiring';

export type ObservationProducers = {
    battery: BatteryStateProducer;
    solar: SolarProductionProducer;
    evCarLink: EvCarLinkProducer;
    /**
     * Teardown for whatever holds durable state. Only the EV car-link probe does
     * (its writes are debounced, so a shutdown needs an explicit flush); battery
     * and solar retain nothing.
     */
    destroy: () => void;
};

export const createObservationProducers = (params: {
    /** Structured-log sink; every producer emits through this one seam. */
    emit: (payload: Record<string, unknown>) => void;
    /** Committed snapshots, read lazily by the EV car-link charger view. */
    getSnapshots: () => readonly ChargerViewInput[];
    /** Persistence port for the probe, injected by the wiring layer; omit to stay in-memory. */
    evCarLinkSnapshotAccess?: EvCarLinkSnapshotAccess;
}): ObservationProducers => {
    const evCarLinkAccess = params.evCarLinkSnapshotAccess;
    return ({
    battery: new BatteryStateProducer((payload) => params.emit({ ...payload })),
    solar: new SolarProductionProducer((payload) => params.emit({ ...payload })),
    evCarLink: createEvCarLinkProducer({
        emit: (payload) => params.emit({ ...payload }),
        getSnapshots: params.getSnapshots,
        snapshotAccess: evCarLinkAccess,
    }),
    destroy: () => evCarLinkAccess?.flush(),
    });
};
