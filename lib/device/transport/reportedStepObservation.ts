import { isNativeSteppedLoadControlEnabled } from '../nativeSteppedLoadWiring';
import { resolveSteppedLoadCeilingStep } from '../steppedLoadPowerCeiling';
import { isEvTargetPowerConfig, resolveEvTargetPowerExactStep } from '../targetPowerReachability';
import { resolveTargetPowerObservationProfile } from '../targetPowerObservationProfile';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { SteppedLoadProfile, TargetPowerSteppedLoadConfig } from '../../../packages/contracts/src/types';

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
        const ladder = resolveEvReportLadder(next.targetPowerConfig, previous, next.steppedLoadProfile);
        if (!ladder) return;
        next.steppedLoadProfile = ladder;
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

/**
 * The ladder an EV report is carried forward on, or `undefined` when the
 * current configuration no longer has the reported rung. An exact reading keeps
 * its own step. A reading admitted as the rung just above its watts is that
 * rung: it is matched on the ladder it was admitted against (which may hold an
 * earlier off-grid step the fresh parse lacks) and re-anchored into this one
 * through the configuration, never re-derived into an off-grid step or dropped.
 */
function resolveEvReportLadder(
    config: TargetPowerSteppedLoadConfig,
    previous: TransportDeviceSnapshot,
    ladder: SteppedLoadProfile,
): SteppedLoadProfile | undefined {
    const { reportedStepId, reportedStepPowerW, steppedLoadProfile: admittedLadder } = previous;
    if (reportedStepId === undefined || reportedStepPowerW === undefined) return undefined;
    const exactStep = resolveEvTargetPowerExactStep(config, reportedStepPowerW);
    if (exactStep?.id === reportedStepId) return resolveTargetPowerObservationProfile(config, ladder, exactStep);
    const ceilingStep = admittedLadder
        && resolveSteppedLoadCeilingStep(admittedLadder, reportedStepId, reportedStepPowerW);
    const rung = ceilingStep && resolveEvTargetPowerExactStep(config, ceilingStep.planningPowerW);
    return rung?.id === reportedStepId ? resolveTargetPowerObservationProfile(config, ladder, rung) : undefined;
}
