import { isBinaryObservedOff } from '../../packages/shared-domain/src/binaryControlState';
import type { ObservedDeviceState } from '../../packages/contracts/src/types';
import type { PlanEngineState } from '../plan/planState';
import {
  type ActivationAttemptSource,
  closeActivationAttemptForShed,
  recordActivationAttemptStart,
} from '../plan/admission';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import { getLogger } from '../logging/logger';

const logger = getLogger('executor/support');

export const shouldSkipUnavailable = (params: {
  // Stage 5: narrowed to the observed surface — this gate reads only the
  // realtime-merged `available` flag, never descriptor/config fields.
  snapshot: Pick<ObservedDeviceState, 'available'> | undefined;
  name: string;
  operation: string;
}): boolean => {
  const {
    snapshot,
    name,
    operation,
  } = params;
  if (snapshot?.available !== false) return false;
  logger.debug({
    event: 'plan_executor_skip_unavailable',
    deviceName: name,
    operation,
    msg: `Capacity: skip ${operation} for ${name}, device unavailable`,
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
export const shouldSkipShedding = (params: {
  state: Pick<PlanEngineState, 'pendingSheds'>;
  deviceId: string;
  deviceName: string;
  snapshotState: Pick<ObservedDeviceState, 'available' | 'binaryControl'> | undefined;
}): boolean => {
  const {
    state,
    deviceId,
    deviceName,
    snapshotState,
  } = params;
  const isUnavailable = snapshotState?.available === false;
  const isAlreadyOff = isBinaryObservedOff(snapshotState);
  if (isUnavailable) {
    logger.debug({
      event: 'plan_shed_skipped',
      reasonCode: 'unavailable',
      deviceId,
      deviceName,
      msg: `Actuator: skip shedding ${deviceName}, device unavailable`,
    });
    return true;
  }
  if (state.pendingSheds.has(deviceId)) {
    logger.debug({
      event: 'plan_shed_skipped',
      reasonCode: 'already_in_progress',
      deviceId,
      deviceName,
      msg: `Actuator: skip shedding ${deviceName}, already in progress`,
    });
    return true;
  }
  if (isAlreadyOff) {
    logger.debug({
      event: 'plan_shed_skipped',
      reasonCode: 'already_off',
      deviceId,
      deviceName,
      msg: `Actuator: skip shedding ${deviceName}, already off in snapshot`,
    });
    return true;
  }
  return false;
};

export const recordDiagnosticsRestore = (params: {
  diagnostics: DeviceDiagnosticsRecorder | undefined;
  deviceId: string;
  name: string;
  nowTs: number;
}): void => {
  params.diagnostics?.recordControlEvent({
    kind: 'pels_restore',
    deviceId: params.deviceId,
    name: params.name,
    nowTs: params.nowTs,
  });
};

export const recordDiagnosticsShed = (params: {
  diagnostics: DeviceDiagnosticsRecorder | undefined;
  deviceId: string;
  name: string;
  nowTs: number;
}): void => {
  params.diagnostics?.recordControlEvent({
    kind: 'pels_shed',
    deviceId: params.deviceId,
    name: params.name,
    nowTs: params.nowTs,
  });
};

export const recordActivationAttemptStarted = (params: {
  state: PlanEngineState;
  diagnostics: DeviceDiagnosticsRecorder | undefined;
  deviceId: string;
  name: string;
  nowTs: number;
  source?: ActivationAttemptSource;
}): void => {
  const result = recordActivationAttemptStart({
    state: params.state,
    deviceId: params.deviceId,
    source: params.source ?? 'pels_restore',
    nowTs: params.nowTs,
  });
  if (result.transition) {
    params.diagnostics?.recordActivationTransition(result.transition, { name: params.name });
  }
};

export const closeActivationAttemptForShedActuation = (params: {
  state: PlanEngineState;
  diagnostics: DeviceDiagnosticsRecorder | undefined;
  deviceId: string;
  name: string;
  nowTs: number;
}): void => {
  const result = closeActivationAttemptForShed({
    state: params.state,
    deviceId: params.deviceId,
    nowTs: params.nowTs,
  });
  if (result.transition) {
    params.diagnostics?.recordActivationTransition(result.transition, { name: params.name });
  }
};
