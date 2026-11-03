import { isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import { resolveCurrentOn, resolveSelectedStepId } from '../observer/observedState';
import { isSteppedLoadSnapshot } from '../../packages/shared-domain/src/steppedLoadObservedState';
import type {
  ObservedDeviceState, SteppedLoadDecoration, SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type {
  ExecutableObservedDeviceState, ExecutableObservedSteppedLoadState, ExecutableObservedTargetState,
} from './executablePlan';
import { getCurrentDrawKw } from '../observer/observedPower';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import type { ExecutorDeviceRead } from './executorDeviceRead';
/**
 * The executor's one observed-state producer. Every path — plan dispatch,
 * drift, the settings-UI execution state and the lifecycle fallback request —
 * builds from the executor's read of the device, and the values the read does
 * not carry are resolved here, once:
 *
 * - `selectedStepId`, the effective rung (`resolveSelectedStepId`)
 *   against `ladder`, the ladder the caller judges the device by: the plan's
 *   for drift, the configured one for the execution state, the step
 *   posture's for a lifecycle step fallback (its first build and retries).
 *   `undefined` reads no rung: plan dispatch takes the current step from the
 *   plan device instead
 *   (`resolveSteppedLoadCurrentFallback`), and a drift check of a device the
 *   plan drives no step for must not fold one into its on/off;
 * - `commandableNow` (`resolveCommandableNow`);
 * - `currentDrawKw` (`getCurrentDrawKw`): the raw `measuredPowerKw` reaches no
 *   further into this layer.
 *
 * The on/off fold is applied here too, so the raw axis (`observedBinaryAxis`)
 * and the fold (`observedEffectiveOn`) answer the same way on every path.
 */
export function buildExecutableObservedDeviceState(
  read: ExecutorDeviceRead,
  ladder: SteppedLoadProfile | undefined,
): ExecutableObservedDeviceState {
  const snapshot = ladder === undefined ? read : {
    ...read,
    steppedLoadProfile: ladder,
    selectedStepId: resolveSelectedStepId(ladder, read.reportedStepId),
  };
  return {
    id: read.id,
    name: read.name,
    snapshot,
    available: read.available,
    commandableNow: resolveCommandableNow(read),
    binaryControl: read.binaryControl,
    observedBinaryAxis: isBinaryOnOrUnknown(read) ? 'on' : 'off',
    observedEffectiveOn: resolveCurrentOn(snapshot),
    target: buildObservedTargetState(read),
    steppedLoad: buildObservedSteppedLoadState(snapshot, getCurrentDrawKw(read)),
  };
}

// Reads only the accepted target observations.
const buildObservedTargetState = (
  snapshot: Pick<ObservedDeviceState, 'targets'>,
): ExecutableObservedTargetState | null => {
  const primaryTarget = snapshot.targets?.[0];
  return primaryTarget ? { observedValue: primaryTarget.value } : null;
};

const buildObservedSteppedLoadState = (
  snapshot: ExecutorDeviceRead & Pick<SteppedLoadDecoration, 'selectedStepId'>,
  currentDrawKw: number,
): ExecutableObservedSteppedLoadState | null => {
  if (!isSteppedLoadSnapshot(snapshot)) return null;
  return {
    // The RAW axis, like `observedBinaryAxis` beside it: every reader of this
    // flag is on the actuation path (`buildCurrentState`, `shedReleaseActuation`)
    // and each already falls back to `isBinaryOnOrUnknown`. Convergence asks the
    // folded question through `observedEffectiveOn` instead.
    on: isBinaryOnOrUnknown(snapshot),
    stepId: snapshot.selectedStepId,
    reportedStepId: snapshot.reportedStepId,
    ...(snapshot.reportedStepPowerW !== undefined ? { reportedStepPowerW: snapshot.reportedStepPowerW } : {}),
    currentDrawKw,
  };
};
