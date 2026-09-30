import { isNativeSteppedLoadControlEnabled } from '../nativeSteppedLoadWiring';
import { isEvTargetPowerConfig, resolveEvTargetPowerExactStep } from '../targetPowerReachability';
import { resolveTargetPowerObservationProfile } from '../targetPowerObservationProfile';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';

/** Keep an exact step cluster atomic when a bundled observation is older. */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export function preserveNewerReportedStepObservation(
    previous: TransportDeviceSnapshot,
    snapshot: TransportDeviceSnapshot,
): void {
    const next = snapshot;
    if (isNativeSteppedLoadControlEnabled(previous) !== isNativeSteppedLoadControlEnabled(next)) return;
    if (!next.steppedLoadProfile || !previous.reportedStepId) return;
    const previousObservedAtMs = previous.reportedStepObservedAtMs;
    const nextObservedAtMs = next.reportedStepObservedAtMs;
    if (
        previousObservedAtMs === undefined
        || (nextObservedAtMs !== undefined && nextObservedAtMs >= previousObservedAtMs)
    ) {
        return;
    }
    if (isEvTargetPowerConfig(next.targetPowerConfig) && previous.reportedStepPowerW !== undefined) {
        const exactStep = resolveEvTargetPowerExactStep(next.targetPowerConfig, previous.reportedStepPowerW);
        if (!exactStep || exactStep.id !== previous.reportedStepId) return;
        next.steppedLoadProfile = resolveTargetPowerObservationProfile(
            next.targetPowerConfig, next.steppedLoadProfile, exactStep,
        );
    }
    if (!next.steppedLoadProfile.steps.some((step) => step.id === previous.reportedStepId)) return;
    next.reportedStepId = previous.reportedStepId;
    if (previous.reportedStepPowerW === undefined) delete next.reportedStepPowerW;
    else next.reportedStepPowerW = previous.reportedStepPowerW;
    next.reportedStepObservedAtMs = previousObservedAtMs;
    const targetPower = next.targets.find((target) => target.id === 'target_power');
    if (targetPower && previous.reportedStepPowerW !== undefined) {
        targetPower.value = previous.reportedStepPowerW;
    }
}
/* eslint-enable functional/immutable-data */
