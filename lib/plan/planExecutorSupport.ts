import type { DevicePlan } from './planTypes';
import type { TargetDeviceSnapshot } from '../utils/types';
import type { PlanEngineState } from './planState';
import {
  formatEvSnapshot,
  getBinaryControlPlan,
  getEvRestoreBlockReason,
} from './planBinaryControl';
import {
  type ActivationAttemptSource,
  recordActivationAttemptStart,
  recordActivationSetback,
} from './planActivationBackoff';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';

type PlanDevice = DevicePlan['devices'][number];

const getCurrentShedTemperature = (
  dev: PlanDevice,
  snapshot: TargetDeviceSnapshot | undefined,
): number | null => {
  if (typeof snapshot?.targets?.[0]?.value === 'number') {
    return snapshot.targets[0].value;
  }
  return typeof dev.currentTarget === 'number' ? dev.currentTarget : null;
};

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

const shouldSkipShedTemperature = (params: {
  dev: PlanDevice;
  targetCap: string | undefined;
  currentTarget: number | null;
  capacityDryRun: boolean;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
}): boolean => {
  const {
    dev,
    targetCap,
    currentTarget,
    capacityDryRun,
    log,
    logDebug,
  } = params;
  if (capacityDryRun) {
    log(
      `Capacity (dry run): would set ${targetCap || 'target'} `
      + `for ${dev.name} to ${dev.plannedTarget ?? '–'}°C (shedding)`,
    );
    return true;
  }
  if (!targetCap || typeof dev.plannedTarget !== 'number') return true;
  if (currentTarget === dev.plannedTarget) {
    logDebug(
      `Capacity: skip setting ${targetCap || 'target'} `
      + `for ${dev.name}, already at ${dev.plannedTarget}°C`,
    );
    return true;
  }
  return false;
};

export const resolveShedTemperaturePlan = (params: {
  dev: PlanDevice;
  snapshot: TargetDeviceSnapshot | undefined;
  capacityDryRun: boolean;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
}): { targetCap: string; plannedTarget: number } | null => {
  const {
    dev,
    snapshot,
    capacityDryRun,
    log,
    logDebug,
  } = params;
  const targetCap = snapshot?.targets?.[0]?.id;
  const currentTarget = getCurrentShedTemperature(dev, snapshot);
  if (shouldSkipShedTemperature({
    dev,
    targetCap,
    currentTarget,
    capacityDryRun,
    log,
    logDebug,
  })) {
    return null;
  }
  if (!targetCap || typeof dev.plannedTarget !== 'number') return null;
  return { targetCap, plannedTarget: dev.plannedTarget };
};

export const canTurnOnDevice = (snapshot?: TargetDeviceSnapshot): boolean => {
  if (!snapshot) return false;
  if (snapshot.available === false) return false;
  const controlPlan = getBinaryControlPlan(snapshot);
  if (!controlPlan?.canSet) return false;
  if (controlPlan.isEv && getEvRestoreBlockReason(snapshot) !== null) {
    return false;
  }
  return true;
};

export const shouldSkipUnavailable = (params: {
  snapshot: TargetDeviceSnapshot | undefined;
  name: string;
  operation: string;
  logDebug: (...args: unknown[]) => void;
}): boolean => {
  const {
    snapshot,
    name,
    operation,
    logDebug,
  } = params;
  if (snapshot?.available !== false) return false;
  logDebug(`Capacity: skip ${operation} for ${name}, device unavailable`);
  return true;
};

export const shouldSkipShedding = (params: {
  state: Pick<PlanEngineState, 'lastDeviceShedMs' | 'pendingSheds'>;
  deviceId: string;
  deviceName: string;
  snapshotState: TargetDeviceSnapshot | undefined;
  logDebug: (...args: unknown[]) => void;
  nowTs?: number;
}): boolean => {
  const {
    state,
    deviceId,
    deviceName,
    snapshotState,
    logDebug,
  } = params;
  const isUnavailable = snapshotState?.available === false;
  const isAlreadyOff = snapshotState?.currentOn === false;
  if (snapshotState?.deviceClass === 'evcharger') {
    logDebug(`Actuator: evaluating EV shed for ${deviceName} (${formatEvSnapshot(snapshotState)})`);
  }
  if (isUnavailable) {
    logDebug(`Actuator: skip shedding ${deviceName}, device unavailable`);
    return true;
  }

  const nowTs = params.nowTs ?? Date.now();
  const throttledElapsedMs = isShedThrottled({ state, deviceId, nowTs });
  if (throttledElapsedMs !== null) {
    logDebug(
      `Actuator: skip shedding ${deviceName}, throttled (${throttledElapsedMs}ms since last)`,
    );
    return true;
  }
  if (state.pendingSheds.has(deviceId)) {
    logDebug(`Actuator: skip shedding ${deviceName}, already in progress`);
    return true;
  }
  if (isAlreadyOff) {
    logDebug(`Actuator: skip shedding ${deviceName}, already off in snapshot`);
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
    kind: 'restore',
    origin: 'pels',
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
    kind: 'shed',
    origin: 'pels',
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
