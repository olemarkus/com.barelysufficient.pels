import type { ObservedDeviceState, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

/**
 * Pure projection from the full transport snapshot down to the observed-state
 * surface (`ObservedDeviceState`). Stage 4a of the snapshot decomposition
 * (`notes/state-management/snapshot-decomposition.md`).
 *
 * Lives in `lib/device/` rather than `packages/contracts/src/` because it is a
 * runtime *function*, and `packages/contracts/src/**` is deploy-excluded source
 * that Homey runtime code may only `import type` from (enforced by
 * `test/runtimePackaging.test.ts`). Transport is the only runtime caller — it
 * builds the decided observed value here before pushing it onto the observer
 * emitter — so transport's own layer is the honest home.
 *
 * It returns a NEW object carrying only the `ObservedDeviceState` fields and
 * must NOT alias transport's mutable nested data. Transport mutates
 * `targets[].value` in place during the fresher-wins merge
 * (`lib/device/deviceTransport.ts` + `transport/managerObservation.ts`), so a
 * shallow alias would let the observer's "decided value" mutate underneath it
 * after the push — defeating the whole point of recording the decided value.
 * `stateOfCharge` / `binaryControlObservation` are replaced (not mutated) by
 * the producer today, but we spread-copy them defensively so a future in-place
 * tweak can't leak across the seam either.
 */
export function projectObservedState(snapshot: TargetDeviceSnapshot): ObservedDeviceState {
    const projected: ObservedDeviceState = {
        id: snapshot.id,
        name: snapshot.name,
        targets: snapshot.targets.map((target) => ({ ...target })),
    };
    if (snapshot.binaryControl !== undefined) projected.binaryControl = { on: snapshot.binaryControl.on };
    if (snapshot.evCharging !== undefined) projected.evCharging = snapshot.evCharging;
    if (snapshot.evChargingState !== undefined) projected.evChargingState = snapshot.evChargingState;
    if (snapshot.stateOfCharge !== undefined) projected.stateOfCharge = { ...snapshot.stateOfCharge };
    if (snapshot.currentTemperature !== undefined) projected.currentTemperature = snapshot.currentTemperature;
    if (snapshot.measuredPowerKw !== undefined) projected.measuredPowerKw = snapshot.measuredPowerKw;
    if (snapshot.measuredPowerObservedAtMs !== undefined) {
        projected.measuredPowerObservedAtMs = snapshot.measuredPowerObservedAtMs;
    }
    if (snapshot.reportedStepId !== undefined) projected.reportedStepId = snapshot.reportedStepId;
    if (snapshot.binaryControlObservation !== undefined) {
        projected.binaryControlObservation = {
            ...snapshot.binaryControlObservation,
            observedCapabilityIds: [...snapshot.binaryControlObservation.observedCapabilityIds],
        };
    }
    if (snapshot.available !== undefined) projected.available = snapshot.available;
    if (snapshot.lastFreshDataMs !== undefined) projected.lastFreshDataMs = snapshot.lastFreshDataMs;
    if (snapshot.lastLocalWriteMs !== undefined) projected.lastLocalWriteMs = snapshot.lastLocalWriteMs;
    if (snapshot.lastUpdated !== undefined) projected.lastUpdated = snapshot.lastUpdated;
    return projected;
}
