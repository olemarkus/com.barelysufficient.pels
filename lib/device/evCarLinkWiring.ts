/**
 * Construction seam for the EV car-link probe.
 *
 * Owns two things the SDK leaf should not: narrowing committed snapshots into
 * flat charger views (the single place the observed-cluster guards are applied
 * for the probe, so the producer reads resolved values and never re-branches on
 * provenance), and defaulting the snapshot owner when no persisted store is
 * injected. Keeping both here leaves `deviceTransport.ts` with a single
 * dependency on this module and no probe-specific field of its own.
 */
import type {
    EvObservedProbe,
    MeasuredPowerObservedProbe,
    StateOfChargeObservedProbe,
    TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import {
    EvCarLinkProducer,
    type EvCarLinkChargerView,
    type EvCarLinkEventEmitter,
} from './evCarLinkProducer';
import { createEmptyEvCarLinkSnapshot } from './evCarLinkSnapshot';

export type ChargerViewInput = TargetDeviceSnapshot
    & EvObservedProbe
    & MeasuredPowerObservedProbe
    & StateOfChargeObservedProbe;

/**
 * Build one view per charger with a resolved plug state.
 *
 * A charger whose plug state is not yet resolved is SKIPPED rather than
 * defaulted: `isEvObserved` returning false covers both "not an EV" and "no
 * trusted state yet", and fabricating a state here would manufacture plug edges
 * out of a cold start — precisely the false link the probe must not produce.
 */
export const buildEvCarLinkChargerViews = (
    snapshots: readonly ChargerViewInput[],
): EvCarLinkChargerView[] => snapshots.flatMap((snapshot) => {
    if (!isEvObserved(snapshot)) return [];
    return [{
        id: snapshot.id,
        name: snapshot.name,
        evChargingState: snapshot.evChargingState,
        measuredPowerW: hasObservedMeasuredPower(snapshot)
            ? Math.round(snapshot.measuredPowerKw * 1000)
            : null,
        controlOn: snapshot.binaryControl?.on === true,
        reportedSocPct: hasObservedStateOfCharge(snapshot)
            ? snapshot.stateOfCharge.percent
            : null,
    }];
});

/** Owner of the link snapshot, supplied by the wiring layer when it persists. */
export type EvCarLinkSnapshotAccess = {
    get: () => EvCarLinkSnapshot;
    set: (snapshot: EvCarLinkSnapshot) => void;
    /**
     * Durable-write hook invoked when the transport is destroyed. The owner
     * debounces normal writes, so without this the votes and observed-stop
     * samples accepted since the last persist tick are lost on restart.
     */
    flush?: () => void;
};

/**
 * Build the probe. Without an injected `snapshotAccess` the snapshot is held in
 * memory for the process lifetime: the probe still runs and still logs, it just
 * forgets its affinity votes and observed-stop samples across a restart.
 */
export const createEvCarLinkProducer = (params: {
    emit: EvCarLinkEventEmitter;
    getSnapshots: () => readonly ChargerViewInput[];
    snapshotAccess?: EvCarLinkSnapshotAccess;
}): EvCarLinkProducer => {
    let inMemory: EvCarLinkSnapshot = createEmptyEvCarLinkSnapshot();
    const access: EvCarLinkSnapshotAccess = params.snapshotAccess ?? {
        get: () => inMemory,
        set: (snapshot) => { inMemory = snapshot; },
    };
    return new EvCarLinkProducer({
        emit: params.emit,
        getChargers: () => buildEvCarLinkChargerViews(params.getSnapshots()),
        getSnapshot: access.get,
        setSnapshot: access.set,
    });
};
