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
import type { EvCarLinkEventEmitter, EvCarLinkProducer, EvCarLinkProducerDeps } from './evCarLinkProducer';
import { carLinkEventDeviceIds, isJournalledCarLinkEvent } from './evCarLinkEvents';
import type { DeviceJournal } from '../ports/deviceJournal';
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
    /** Where car-link events go: the structured log and the device journal (`createCarLinkEventEmitter`). */
    carLinkEvents: EvCarLinkEventEmitter;
};

/**
 * `emit` is the structured-log sink every producer emits through;
 * `getSnapshots` the committed snapshots, read lazily by the EV car-link
 * charger view; `evCarLinkSnapshotAccess` the probe's persistence port,
 * injected by the wiring layer (without one the probe stays in-memory); and
 * the last two the probe's callbacks for a fresh battery level from a
 * charger's associated car and for a charger's car session ending (see the
 * probe deps).
 */
/**
 * Car-link events go to the structured log and to the device journal: a problem
 * report made hours after a missed link needs them, and by then Homey's
 * attached log has rolled over.
 */
const createCarLinkEventEmitter = (
    emit: (payload: Record<string, unknown>) => void,
    journal: DeviceJournal,
): EvCarLinkEventEmitter => (event) => {
    emit({ ...event });
    if (isJournalledCarLinkEvent(event)) journal.record(carLinkEventDeviceIds(event), event);
};

export const createObservationProducers = (
    emit: (payload: Record<string, unknown>) => void,
    /** Where the car-link probe's events are also kept, for problem reports. */
    deviceJournal: DeviceJournal,
    getSnapshots: () => readonly ChargerViewInput[],
    evCarLinkSnapshotAccess: EvCarLinkSnapshotAccess | undefined,
    onAssociatedCarStateOfCharge: EvCarLinkProducerDeps['onAssociatedCarStateOfCharge'],
    onAssociationEnded: EvCarLinkProducerDeps['onAssociationEnded'],
    /** The cars the owner selected for a charger (`DeviceControlSettings`). */
    getSelectedCarIds: (chargerId: string) => readonly string[],
): ObservationProducers => {
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
    const observationEmit = createObservationEmitGate({ emit });
    const carLinkEvents = createCarLinkEventEmitter(emit, deviceJournal);
    return ({
    temperature: new TemperatureAdjustmentObserver(),
    battery: new BatteryStateProducer((payload) => observationEmit({ ...payload })),
    solar: new SolarProductionProducer((payload) => observationEmit({ ...payload })),
    evCarLink: createEvCarLinkProducer(
        carLinkEvents,
        getSnapshots,
        evCarLinkSnapshotAccess,
        onAssociatedCarStateOfCharge,
        onAssociationEnded,
        getSelectedCarIds,
    ),
    carLinkEvents,
    });
};
