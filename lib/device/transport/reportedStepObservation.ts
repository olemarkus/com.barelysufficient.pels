import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';

/** Keep an exact step cluster atomic when a bundled observation is older. */
export function preserveNewerReportedStepObservation(
    previous: TransportDeviceSnapshot,
    snapshot: TransportDeviceSnapshot,
): void {
    const next = snapshot;
    const previousObservedAtMs = previous.reportedStepObservedAtMs;
    const nextObservedAtMs = next.reportedStepObservedAtMs;
    if (
        previousObservedAtMs === undefined
        || (nextObservedAtMs !== undefined && nextObservedAtMs >= previousObservedAtMs)
    ) {
        return;
    }
    if (previous.reportedStepId === undefined) delete next.reportedStepId;
    else next.reportedStepId = previous.reportedStepId;
    if (previous.reportedStepPowerW === undefined) delete next.reportedStepPowerW;
    else next.reportedStepPowerW = previous.reportedStepPowerW;
    next.reportedStepObservedAtMs = previousObservedAtMs;
    const targetPower = next.targets.find((target) => target.id === 'target_power');
    if (targetPower && previous.reportedStepPowerW !== undefined) {
        targetPower.value = previous.reportedStepPowerW;
    }
}
