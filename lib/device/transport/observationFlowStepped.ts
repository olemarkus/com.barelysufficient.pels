import { PELS_MEASURE_STEP_CAPABILITY_ID } from '../../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import { isNativeSteppedLoadControlEnabled } from '../nativeSteppedLoadWiring';
import {
    isEvTargetPowerConfig, resolveEvTargetPowerExactStep, resolveEvTargetPowerExactStepById,
} from '../targetPowerReachability';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { DeviceConfigurationStore } from '../deviceConfiguration';
import type { FlowSteppedLoadAdmission, FlowSteppedLoadObservation } from '../../ports/flowSteppedLoadAdmission';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import { resolveTargetPowerObservationProfile } from '../targetPowerObservationProfile';

/** Resolve source authority, identity, and exact power at the device boundary. */
/* eslint-disable functional/immutable-data -- Transport owns the accepted snapshot and configuration. */
// eslint-disable-next-line complexity -- Admission and atomic publication are one boundary transaction.
export function admitFlowSteppedLoadReport(
    snapshotStore: TransportSnapshotStore,
    configuration: DeviceConfigurationStore,
    onSnapshotMutated: (snapshot: TargetDeviceSnapshot, nowMs: number) => void,
    dispatchObservedStateForDevice: (deviceId: string, capabilityId: string) => void,
    deviceId: string,
    stepId: string,
    planningPowerW?: number,
): FlowSteppedLoadAdmission {
    const observedAtMs = Date.now();
    const snapshot = snapshotStore.getSnapshotByDeviceId(deviceId);
    if (!snapshot) return { kind: 'invalid' };
    if (isNativeSteppedLoadControlEnabled(snapshot)) return { kind: 'native_control' };
    if (!snapshot.steppedLoadProfile || isInvalidFlowFeedback(stepId, planningPowerW, observedAtMs)) {
        return { kind: 'invalid' };
    }
    if ((snapshot.reportedStepObservedAtMs ?? 0) > observedAtMs) return { kind: 'unchanged' };
    const exactStep = planningPowerW === undefined
        ? resolveEvTargetPowerExactStepById(snapshot.targetPowerConfig, stepId)
        : resolveEvTargetPowerExactStep(snapshot.targetPowerConfig, planningPowerW);
    if ((isEvTargetPowerConfig(snapshot.targetPowerConfig) && !exactStep)
        || (exactStep && exactStep.id !== stepId)) return { kind: 'invalid' };
    const step = exactStep ?? snapshot.steppedLoadProfile.steps.find((candidate) => candidate.id === stepId);
    if (!step) return { kind: 'invalid' };
    const observation: FlowSteppedLoadObservation = {
        deviceId, stepId, planningPowerW: Math.round(planningPowerW ?? step.planningPowerW), observedAtMs,
    };
    const changed = snapshot.reportedStepId !== stepId
        || snapshot.reportedStepPowerW !== observation.planningPowerW
        || snapshot.reportedStepObservedAtMs !== observedAtMs;
    // Repeated valid feedback still answers a newer command or plan intent.
    // Only publishing a changed observation is conditional; admission is not.
    if (!changed) return { kind: 'accepted', profile: snapshot.steppedLoadProfile, observation };
    if (exactStep && snapshot.targetPowerConfig) {
        snapshot.steppedLoadProfile = resolveTargetPowerObservationProfile(
            snapshot.targetPowerConfig, snapshot.steppedLoadProfile, exactStep,
        );
    }
    snapshot.reportedStepId = stepId;
    snapshot.reportedStepPowerW = observation.planningPowerW;
    snapshot.reportedStepObservedAtMs = observedAtMs;
    snapshot.lastFreshDataMs = Math.max(snapshot.lastFreshDataMs ?? 0, observedAtMs);
    snapshot.lastUpdated = snapshot.lastFreshDataMs;
    const admitted: FlowSteppedLoadAdmission = { kind: 'accepted', profile: snapshot.steppedLoadProfile, observation };
    configuration.set(snapshot);
    onSnapshotMutated(snapshot, observedAtMs);
    dispatchObservedStateForDevice(deviceId, PELS_MEASURE_STEP_CAPABILITY_ID);
    return admitted;
}
/* eslint-enable functional/immutable-data */

function isInvalidFlowFeedback(stepId: string, planningPowerW: number | undefined, observedAtMs: number): boolean {
    return !stepId.trim()
        || (planningPowerW !== undefined && (!Number.isFinite(planningPowerW) || planningPowerW < 0))
        || !Number.isFinite(observedAtMs) || observedAtMs < 0;
}
