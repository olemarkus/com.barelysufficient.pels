import { TemperatureAdjustmentObserver } from './temperatureAdjustmentObserver';
/**
 * Construction seam for the device layer's read-only observation producers.
 *
 * These producers consume committed device observations, hold bounded state,
 * and surface facts without issuing device commands. Building them
 * together keeps the SDK leaf (`deviceTransport.ts`) free of their individual
 * construction details, and gives them a single place to document that
 * shared contract.
 *
 * - `battery` — home-battery SoC + signed power (`batteryStateProducer.ts`)
 * - `solar` — PV production (`solarProductionProducer.ts`)
 * - `evCarLink` — EV car-to-charger correlation probe (`evCarLinkProducer.ts`)
 * - `temperature` — external target changes (`temperatureAdjustmentObserver.ts`)
 */
import { BatteryStateProducer } from './batteryStateProducer';
import { createObservationEmitGate } from './observationEmitGate';
import { SolarProductionProducer } from './solarProductionProducer';
import type { EvCarLinkProducer, EvCarLinkProducerDeps } from './evCarLinkProducer';
import {
    createEvCarLinkProducer,
    type ChargerViewInput,
    type EvCarLinkSnapshotAccess,
} from './evCarLinkWiring';

export type ObservationProducers = {
    temperature: TemperatureAdjustmentObserver;
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
    /** A fresh battery level from a charger's associated car (see the probe deps). */
    onAssociatedCarStateOfCharge?: EvCarLinkProducerDeps['onAssociatedCarStateOfCharge'];
    /** A charger's car session ended. */
    onAssociationEnded?: EvCarLinkProducerDeps['onAssociationEnded'];
}): ObservationProducers => {
    const evCarLinkAccess = params.evCarLinkSnapshotAccess;
    // Gated: battery and solar re-report the SAME value on every fetch (~1/min),
    // so an unchanged repeat carries nothing. The gate wraps them here rather
    // than inside either producer so their "retain nothing" contract stays
    // literally true — dedup state belongs to the log sink, not an observation.
    //
    // NOT gated: the EV car-link probe. Its events are discrete OCCURRENCES
    // ("resolved", "ambiguous", "self-stopped"), not observations of a value,
    // and a repeat is its signal rather than noise — `ev_car_link_ambiguous`
    // carries a fully static payload, so gating it would swallow a genuine
    // second occurrence. It is also not a volume problem. See the caller
    // contract in `observationEmitGate.ts`.
    const observationEmit = createObservationEmitGate({ emit: params.emit });
    return ({
    temperature: new TemperatureAdjustmentObserver(),
    battery: new BatteryStateProducer((payload) => observationEmit({ ...payload })),
    solar: new SolarProductionProducer((payload) => observationEmit({ ...payload })),
    evCarLink: createEvCarLinkProducer({
        emit: (payload) => params.emit({ ...payload }),
        getSnapshots: params.getSnapshots,
        snapshotAccess: evCarLinkAccess,
        onAssociatedCarStateOfCharge: params.onAssociatedCarStateOfCharge,
        onAssociationEnded: params.onAssociationEnded,
    }),
    destroy: () => evCarLinkAccess?.flush(),
    });
};
