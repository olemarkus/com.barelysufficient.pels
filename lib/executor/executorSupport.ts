import { isBinaryObservedOff } from '../../packages/shared-domain/src/binaryControlState';
import type { ObservedDeviceState } from '../../packages/contracts/src/types';
import type { PlanEngineState } from '../plan/planState';
import {
  closeActivationAttemptForShed,
  recordActivationAttemptStart,
} from '../plan/admission';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import { getDebugEmitter } from '../logging/logger';

/**
 * Command decisions go to the `plan` debug topic: a skip is the executor half of
 * the shed/restore decision the owner already enables that topic to read, so it
 * should not need a second switch. Resolved here rather than through the module
 * logger, whose `.debug` the `info` root discards — which is why every
 * `*_command_skipped` event was absent from production.
 */
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

export const shouldSkipUnavailable = (
  // Stage 5: narrowed to the observed surface — this gate reads only the
  // realtime-merged `available` flag, never descriptor/config fields.
  snapshot: Pick<ObservedDeviceState, 'available'> | undefined,
  name: string,
  operation: string,
): boolean => {
  if (snapshot?.available !== false) return false;
  emitExecutorDebug({
    event: 'plan_executor_skip_unavailable',
    deviceName: name,
    operation,
  });
  return true;
};

/**
 * The executor's own precheck before it writes a shed: is this device reachable,
 * and is one of my own writes already in flight for it? Both are facts about the
 * write, not about pacing.
 *
 * There is deliberately NO cooldown here. Pacing — how soon PELS may change a
 * device again — is planner admission, and enforcing it in the write path let the
 * executor silently drop a shed the planner had already decided. See
 * `notes/state-management/actuation-clocks-and-settle.md`.
 */
export const shouldSkipShedding = (
  actuation: PlanEngineState['actuation'],
  deviceId: string,
  deviceName: string,
  snapshotState: Pick<ObservedDeviceState, 'available' | 'binaryControl'> | undefined,
): boolean => {
  const isUnavailable = snapshotState?.available === false;
  const isAlreadyOff = isBinaryObservedOff(snapshotState);
  if (isUnavailable) {
    emitExecutorDebug({
      event: 'plan_shed_skipped',
      reasonCode: 'unavailable',
      deviceId,
      deviceName,
    });
    return true;
  }
  if (actuation.isShedInFlight(deviceId)) {
    emitExecutorDebug({
      event: 'plan_shed_skipped',
      reasonCode: 'already_in_progress',
      deviceId,
      deviceName,
    });
    return true;
  }
  if (isAlreadyOff) {
    emitExecutorDebug({
      event: 'plan_shed_skipped',
      reasonCode: 'already_off',
      deviceId,
      deviceName,
    });
    return true;
  }
  return false;
};

export const recordActivationAttemptStarted = (
  state: PlanEngineState,
  diagnostics: DeviceDiagnosticsRecorder | undefined,
  deviceId: string,
  name: string,
  nowTs: number,
): void => {
  const transition = recordActivationAttemptStart(state, deviceId, 'pels_restore', nowTs);
  if (transition) diagnostics?.recordActivationTransition(transition, { name });
};

export const closeActivationAttemptForShedActuation = (
  state: PlanEngineState,
  diagnostics: DeviceDiagnosticsRecorder | undefined,
  deviceId: string,
  name: string,
  nowTs: number,
): void => {
  const transition = closeActivationAttemptForShed(state, deviceId, nowTs);
  if (transition) diagnostics?.recordActivationTransition(transition, { name });
};
