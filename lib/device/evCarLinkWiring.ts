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
import type { EvCarLinkChargerView } from './evCarLinkChargerView';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { hasObservedMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import {
    EvCarLinkProducer,
    type EvCarLinkProducerDeps,
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
    // Unknowns are OMITTED, never defaulted: a fabricated 0 W would read as
    // "idle" and manufacture a self-stop, and a fabricated charge would be
    // compared against the car's as if the flow card had reported.
    return [{
        id: snapshot.id,
        name: snapshot.name,
        evChargingState: snapshot.evChargingState,
        // Carries its observation time, not just its value: a retained idle
        // reading from before the session would otherwise look like live proof
        // the charger is delivering nothing. The consumer decides currency —
        // a genuinely idle charger legitimately stops emitting, so "recent" is
        // the wrong test; "observed during this session" is the right one.
        ...(hasObservedMeasuredPower(snapshot)
            ? {
                measuredPowerW: Math.round(snapshot.measuredPowerKw * 1000),
                ...(snapshot.measuredPowerObservedAtMs === undefined
                    ? {}
                    : { measuredPowerObservedAtMs: snapshot.measuredPowerObservedAtMs }),
            }
            : {}),
        controlOn: snapshot.binaryControl?.on === true,
        // `hasObservedStateOfCharge` is presence-only, so it also passes a
        // percentage the observation layer has already marked stale or
        // invalidated (an unplug/reconnect). Comparing the car against that would
        // corrupt the very flow-card accuracy signal the shadow exists to report.
        ...(hasObservedStateOfCharge(snapshot) && snapshot.stateOfCharge.status === 'fresh'
            ? { reportedSocPct: snapshot.stateOfCharge.percent }
            : {}),
    }];
});

/**
 * Owner of the link snapshot. Backed by `EvCarLinkStore` when a Homey runtime is
 * available; otherwise in-memory for the process lifetime.
 */
export type EvCarLinkSnapshotAccess = {
    get: () => EvCarLinkSnapshot;
    set: (snapshot: EvCarLinkSnapshot) => void;
    /**
     * Durable-write hook invoked when the transport is destroyed. Normal writes
     * are debounced, so without this the votes and observed-stop samples accepted
     * since the last persist tick are lost on restart.
     */
    flush: () => void;
};

export const createEvCarLinkProducer = (params: {
    emit: EvCarLinkEventEmitter;
    getSnapshots: () => readonly ChargerViewInput[];
    snapshotAccess?: EvCarLinkSnapshotAccess;
    onAssociatedCarStateOfCharge?: EvCarLinkProducerDeps['onAssociatedCarStateOfCharge'];
    onAssociationEnded?: EvCarLinkProducerDeps['onAssociationEnded'];
}): EvCarLinkProducer => {
    let inMemory: EvCarLinkSnapshot = createEmptyEvCarLinkSnapshot();
    const access: EvCarLinkSnapshotAccess = params.snapshotAccess ?? {
        get: () => inMemory,
        set: (snapshot) => { inMemory = snapshot; },
        flush: () => {},
    };
    return new EvCarLinkProducer({
        emit: params.emit,
        getChargers: () => buildEvCarLinkChargerViews(params.getSnapshots()),
        getSnapshot: access.get,
        setSnapshot: access.set,
        onAssociatedCarStateOfCharge: params.onAssociatedCarStateOfCharge,
        onAssociationEnded: params.onAssociationEnded,
    });
};
