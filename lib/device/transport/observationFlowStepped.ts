import { PELS_MEASURE_STEP_CAPABILITY_ID } from '../../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { isNativeSteppedLoadControlEnabled } from '../nativeSteppedLoadWiring';
import type { TransportContext } from './transportContext';

export type FlowSteppedLoadObservation = {
    deviceId: string;
    stepId: string;
    planningPowerW: number;
    observedAtMs: number;
};

/** Admit validated Flow exact-step evidence into transport-owned observed state. */
export function reportFlowSteppedObservation(
    ctx: TransportContext,
    observation: FlowSteppedLoadObservation,
): boolean {
    const snapshot = ctx.latestSnapshotById.get(observation.deviceId);
    const planningPowerW = Math.round(observation.planningPowerW);
    if (
        !snapshot
        || isNativeSteppedLoadControlEnabled(snapshot)
        || !observation.stepId.trim()
        || !Number.isFinite(observation.planningPowerW)
        || observation.planningPowerW < 0
        || !Number.isFinite(observation.observedAtMs)
        || observation.observedAtMs < 0
        || (snapshot.reportedStepObservedAtMs ?? 0) > observation.observedAtMs
    ) {
        return false;
    }
    const changed = snapshot.reportedStepId !== observation.stepId
        || snapshot.reportedStepPowerW !== planningPowerW
        || snapshot.reportedStepObservedAtMs !== observation.observedAtMs;
    snapshot.reportedStepId = observation.stepId;
    snapshot.reportedStepPowerW = planningPowerW;
    snapshot.reportedStepObservedAtMs = observation.observedAtMs;
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observation.observedAtMs);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    if (!changed) return false;
    ctx.onSnapshotMutated?.(snapshot, observation.observedAtMs);
    ctx.dispatchObservedStateForDevice(observation.deviceId, PELS_MEASURE_STEP_CAPABILITY_ID);
    return true;
}
