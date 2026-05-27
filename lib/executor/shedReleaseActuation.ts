import type { ShedAction } from '../plan/planTypes';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import {
  applyBinarySheddingToDevice,
  type PlanExecutorBinaryContext,
} from './binaryExecutor';
import {
  applyTargetUpdate,
  type PlanExecutorTargetContext,
} from './targetExecutor';
import type {
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
} from './executablePlan';
import type { PlanActuationMode } from './executorTypes';
import { getLogger } from '../logging/logger';

const logger = getLogger('executor/shed-release');

// shed_release fires the device's configured shedBehavior exactly once for a cap-off device
// whose smart task transitioned out of plannable status (or is in an idle bucket). The
// executor resolves the concrete actuation primitive at apply time from getShedBehavior():
//   'turn_off' / 'set_step' → binary shed via the onoff/evcharger_charging capability
//   'set_temperature'       → target write at the configured shed setpoint
// Each axis's existing idempotency guard prevents re-actuation when the device is already in
// the configured shed posture (binary pendingSheds + observed-off; target pendingTargetCommand
// dampening inside applyTargetUpdate), so the per-cycle re-emission of the intent is safe.
//
// 'set_step' on a device without binary control (a stepped device whose only handle is the
// step capability) is a known gap: the planner's regular shed pipeline takes a two-phase
// step-then-off path, but lifecycle release does not currently re-project a shed-purpose
// stepped intent. Such devices fall through to the binary path and skip cleanly when the
// controlCapabilityId guard rejects them — they stay in their pre-release posture.
// See TODO.md (smart-task release for non-binary-control stepped devices).
export type ShedReleaseActuationDeps = {
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  buildBinaryExecutorContext: () => PlanExecutorBinaryContext;
  buildTargetExecutorContext: () => PlanExecutorTargetContext;
};

export const applyShedReleaseIntent = async (params: {
  intent: ExecutableReleaseIntent;
  observed: ExecutableObservedDeviceState | undefined;
  snapshot: TargetDeviceSnapshot | undefined;
  mode: PlanActuationMode;
  deps: ShedReleaseActuationDeps;
}): Promise<boolean> => {
  const { intent, observed, snapshot, mode, deps } = params;
  if (intent.kind !== 'shed_release') return false;
  const behavior = deps.getShedBehavior(intent.deviceId);
  if (behavior.action === 'set_temperature' && behavior.temperature !== null) {
    return applyShedReleaseTemperature({ intent, shedTemperature: behavior.temperature, observed, mode, deps });
  }
  return applyShedReleaseBinaryOff({ intent, behavior, snapshot, deps });
};

const applyShedReleaseTemperature = async (params: {
  intent: ExecutableReleaseIntent;
  shedTemperature: number;
  observed: ExecutableObservedDeviceState | undefined;
  mode: PlanActuationMode;
  deps: ShedReleaseActuationDeps;
}): Promise<boolean> => {
  const { intent, shedTemperature, observed, mode, deps } = params;
  const target = observed?.target;
  if (!target) return false;
  if (typeof target.observedValue === 'number' && target.observedValue === shedTemperature) return false;
  return applyTargetUpdate(deps.buildTargetExecutorContext(), {
    deviceId: intent.deviceId,
    name: intent.name,
    targetCap: target.targetCap,
    desired: shedTemperature,
    observedValue: target.observedValue,
    isRestoring: false,
  }, mode);
};

const applyShedReleaseBinaryOff = async (params: {
  intent: ExecutableReleaseIntent;
  behavior: { action: ShedAction };
  snapshot: TargetDeviceSnapshot | undefined;
  deps: ShedReleaseActuationDeps;
}): Promise<boolean> => {
  const { intent, behavior, snapshot, deps } = params;
  // Defensive: EV chargers must route through the dedicated ev_pause path; the projection
  // already rejects shed_release for them, but guard at apply time too.
  if (snapshot?.controlCapabilityId === 'evcharger_charging') return false;
  if (!snapshot?.controlCapabilityId) {
    // No binary handle. Stepped-only devices with set_step shedBehavior land here — see the
    // module-level TODO. Stay silent on turn_off (rare config) but log a one-off for
    // set_step so the gap shows up in prod traces.
    if (behavior.action === 'set_step') {
      logger.debug({
        event: 'shed_release_skipped',
        reasonCode: 'no_binary_handle_for_set_step',
        deviceId: intent.deviceId,
        deviceName: intent.name,
      });
    }
    return false;
  }
  if (snapshot.currentOn === false) return false;
  return applyBinarySheddingToDevice(deps.buildBinaryExecutorContext(), {
    deviceId: intent.deviceId,
    deviceName: intent.name,
  });
};
