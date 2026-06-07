import type { ObservedDeviceState, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { PlanEngineState } from './planState';
import {
  isCanSetControl,
  isCommandableNow,
} from '../device/deviceActionProjection';
import {
  type ActivationAttemptSource,
  closeActivationAttemptForShed,
  recordActivationAttemptStart,
  recordActivationSetback,
} from './admission';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import { getLogger } from '../logging/logger';

const logger = getLogger('plan/executor-support');

const isShedThrottled = (params: {
  state: Pick<PlanEngineState, 'lastDeviceShedMs'>;
  deviceId: string;
  nowTs: number;
}): number | null => {
  const lastForDevice = params.state.lastDeviceShedMs[params.deviceId];
  const throttleMs = 5000;
  if (!lastForDevice) return null;
  const elapsedMs = params.nowTs - lastForDevice;
  return elapsedMs < throttleMs ? elapsedMs : null;
};

/**
 * Restore-time admission gate: true when the device is commandable AND its
 * binary control capability is writeable this cycle. Reads producer-resolved
 * bits (`commandableNow`, `canSetControlResolved`) when present (planner
 * call sites) and falls back to fresh resolution from raw snapshot fields
 * (`evChargingState`, `available`, `controlCapabilityId`, `capabilities`,
 * `canSetControl`, legacy `canSetOnOff`) for the executor call sites that
 * still pass `TargetDeviceSnapshot`.
 *
 * Chunk 6 of the planner-detype refactor: producer now resolves both bits
 * so this gate no longer round-trips through `getBinaryControlPlan` +
 * `getEvRestoreBlockReason`.
 */
export const canTurnOnDevice = (snapshot?: TargetDeviceSnapshot): boolean => {
  if (!snapshot) return false;
  if (!isCommandableNow(snapshot)) return false;
  if (!isCanSetControl({
    controlCapabilityId: snapshot.controlCapabilityId,
    capabilities: snapshot.capabilities,
    canSetControl: snapshot.canSetControl,
    canSetOnOff: (snapshot as TargetDeviceSnapshot & { canSetOnOff?: boolean }).canSetOnOff,
  })) return false;
  return true;
};

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

export const shouldSkipShedding = (params: {
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'pendingSheds'>;
  deviceId: string;
  deviceName: string;
  snapshotState: TargetDeviceSnapshot | undefined;
  nowTs?: number;
}): boolean => {
  const {
    state,
    deviceId,
    deviceName,
    snapshotState,
  } = params;
  const isUnavailable = snapshotState?.available === false;
  const isAlreadyOff = snapshotState?.binaryControl?.on === false;
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

  const nowTs = params.nowTs ?? Date.now();
  const throttledElapsedMs = isShedThrottled({ state, deviceId, nowTs });
  if (throttledElapsedMs !== null) {
    logger.debug({
      event: 'plan_shed_skipped',
      reasonCode: 'throttled',
      deviceId,
      deviceName,
      throttledElapsedMs,
      msg: `Actuator: skip shedding ${deviceName}, throttled (${throttledElapsedMs}ms since last)`,
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

export const recordActivationSetbackForDevice = (params: {
  state: PlanEngineState;
  diagnostics: DeviceDiagnosticsRecorder | undefined;
  deviceId: string;
  name: string;
  nowTs: number;
}): void => {
  const result = recordActivationSetback({
    state: params.state,
    deviceId: params.deviceId,
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
