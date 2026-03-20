import {
  TARGET_COMMAND_RETRY_DELAYS_MS,
  TARGET_WAITING_LOG_REPEAT_MS,
} from './planConstants';
import type { PendingTargetCommandState, PlanEngineState } from './planState';
import type {
  DevicePlan,
  PendingTargetCommandSummary,
  PendingTargetObservationSource,
  PlanInputDevice,
} from './planTypes';

type PendingTargetDecision =
  | { type: 'send' }
  | { type: 'retry'; pending: PendingTargetCommandState }
  | { type: 'skip'; pending: PendingTargetCommandState; remainingMs: number };

export function getPendingTargetCommandDecision(params: {
  state: PlanEngineState;
  deviceId: string;
  capabilityId: string;
  desired: number;
  nowMs: number;
}): PendingTargetDecision {
  const { state, deviceId, capabilityId, desired, nowMs } = params;
  const pending = state.pendingTargetCommands[deviceId];
  if (!pending || pending.capabilityId !== capabilityId || pending.desired !== desired) {
    return { type: 'send' };
  }
  if (nowMs >= pending.nextRetryAtMs) {
    return { type: 'retry', pending };
  }
  return {
    type: 'skip',
    pending,
    remainingMs: pending.nextRetryAtMs - nowMs,
  };
}

export function recordPendingTargetCommandAttempt(params: {
  state: PlanEngineState;
  deviceId: string;
  capabilityId: string;
  desired: number;
  nowMs: number;
  observedValue?: unknown;
}): PendingTargetCommandState {
  const {
    state,
    deviceId,
    capabilityId,
    desired,
    nowMs,
    observedValue,
  } = params;
  const previous = state.pendingTargetCommands[deviceId];
  const isRetry = previous?.capabilityId === capabilityId && previous.desired === desired;
  const retryCount = isRetry ? previous.retryCount + 1 : 0;
  const entry: PendingTargetCommandState = {
    capabilityId,
    desired,
    startedMs: isRetry ? previous.startedMs : nowMs,
    lastAttemptMs: nowMs,
    retryCount,
    nextRetryAtMs: nowMs + getTargetCommandRetryDelayMs(retryCount),
    lastObservedValue: resolvePendingTargetObservedValue({
      isRetry,
      observedValue,
      previous,
    }),
    lastObservedSource: isRetry ? previous?.lastObservedSource : undefined,
    lastObservedAtMs: isRetry ? previous?.lastObservedAtMs : undefined,
    lastWaitingLogAtMs: isRetry ? previous?.lastWaitingLogAtMs : undefined,
  };
  state.pendingTargetCommands[deviceId] = entry;
  return entry;
}

export function prunePendingTargetCommandsForPlan(params: {
  state: PlanEngineState;
  plan: DevicePlan;
  logDebug: (message: string) => void;
}): boolean {
  const { state, plan, logDebug } = params;
  const planById = new Map(plan.devices.map((device) => [device.id, device]));
  let changed = false;
  for (const [deviceId, pending] of Object.entries(state.pendingTargetCommands)) {
    const device = planById.get(deviceId);
    const shouldKeep = Boolean(
      device
      && typeof device.plannedTarget === 'number'
      && device.plannedTarget !== device.currentTarget
      && device.plannedTarget === pending.desired,
    );
    if (shouldKeep) continue;
    delete state.pendingTargetCommands[deviceId];
    changed = true;
    logDebug(
      `Capacity: cleared pending ${pending.capabilityId} for ${device?.name || deviceId}, `
      + `current plan no longer wants ${pending.desired}°C`,
    );
  }
  return changed;
}

export function syncPendingTargetCommands(params: {
  state: PlanEngineState;
  liveDevices: PlanInputDevice[];
  source: PendingTargetObservationSource;
  log?: (message: string) => void;
  logDebug: (message: string) => void;
}): boolean {
  const {
    state,
    liveDevices,
    source,
    log,
    logDebug,
  } = params;
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  let changed = false;

  for (const [deviceId, pending] of Object.entries(state.pendingTargetCommands)) {
    const liveDevice = liveById.get(deviceId);
    if (!liveDevice) {
      if (clearPendingTargetCommandForMissingDevice({
        state,
        deviceId,
        pending,
        source,
        logDebug,
      })) {
        changed = true;
      }
      continue;
    }
    const observedValue = getObservedTargetValue(liveDevice, pending.capabilityId);

    if (Object.is(observedValue, pending.desired)) {
      delete state.pendingTargetCommands[deviceId];
      changed = true;
      logDebug(
        `Capacity: confirmed ${pending.capabilityId} for ${liveDevice.name || deviceId} `
        + `at ${pending.desired}°C via ${source}`,
      );
      continue;
    }

    if (
      Object.is(pending.lastObservedValue, observedValue)
      && pending.lastObservedSource === source
    ) {
      maybeLogRepeatedPendingConfirmation({
        pending,
        name: liveDevice.name || deviceId,
        log,
        source,
        observedValue,
      });
      continue;
    }

    const previousObservedValue = pending.lastObservedValue;
    const previousObservedSource = pending.lastObservedSource;
    pending.lastObservedValue = observedValue;
    pending.lastObservedSource = source;
    pending.lastObservedAtMs = Date.now();
    changed = true;
    logDebug(
      `Capacity: waiting for ${pending.capabilityId} confirmation for ${liveDevice.name || deviceId}; `
      + `observed ${formatObservedTarget(observedValue)} via ${source}, `
      + `expected ${pending.desired}°C`,
    );
    const waitingLog = buildPendingConfirmationLogMessage({
      name: liveDevice.name || deviceId,
      capabilityId: pending.capabilityId,
      desired: pending.desired,
      source,
      previousObservedValue,
      previousObservedSource,
      observedValue,
    });
    if (log && waitingLog) {
      pending.lastWaitingLogAtMs = Date.now();
      log(waitingLog);
    }
  }

  return changed;
}

export function decoratePlanWithPendingTargetCommands(
  state: PlanEngineState,
  plan: DevicePlan,
): DevicePlan {
  const devices = plan.devices.map((device) => {
    const pending = state.pendingTargetCommands[device.id];
    const shouldExpose = pending
      && typeof device.plannedTarget === 'number'
      && device.plannedTarget !== device.currentTarget
      && device.plannedTarget === pending.desired;
    if (!shouldExpose) {
      if (!device.pendingTargetCommand) return device;
      return {
        ...device,
        pendingTargetCommand: undefined,
      };
    }
    const summary: PendingTargetCommandSummary = {
      desired: pending.desired,
      retryCount: pending.retryCount,
      nextRetryAtMs: pending.nextRetryAtMs,
      lastObservedValue: pending.lastObservedValue,
      lastObservedSource: pending.lastObservedSource,
    };
    return {
      ...device,
      pendingTargetCommand: summary,
    };
  });

  return {
    ...plan,
    devices,
  };
}

function getTargetCommandRetryDelayMs(retryCount: number): number {
  const index = Math.min(retryCount, TARGET_COMMAND_RETRY_DELAYS_MS.length - 1);
  return TARGET_COMMAND_RETRY_DELAYS_MS[index];
}

function getObservedTargetValue(
  liveDevice: PlanInputDevice,
  capabilityId: string,
): unknown {
  return liveDevice.targets.find((target) => target.id === capabilityId)?.value;
}

function clearPendingTargetCommandForMissingDevice(params: {
  state: PlanEngineState;
  deviceId: string;
  pending: PendingTargetCommandState;
  source: PendingTargetObservationSource;
  logDebug: (message: string) => void;
}): boolean {
  const { state, deviceId, pending, source, logDebug } = params;
  const shouldClearMissingPending = source === 'snapshot_refresh' || source === 'rebuild';
  if (!shouldClearMissingPending) return false;
  delete state.pendingTargetCommands[deviceId];
  logDebug(
    `Capacity: cleared pending ${pending.capabilityId} for ${deviceId}, `
    + `device missing from live state during ${source}`,
  );
  return true;
}

function resolvePendingTargetObservedValue(params: {
  isRetry: boolean;
  observedValue: unknown;
  previous?: PendingTargetCommandState;
}): unknown {
  const { isRetry, observedValue, previous } = params;
  if (observedValue !== undefined) return observedValue;
  return isRetry ? previous?.lastObservedValue : undefined;
}

function formatObservedTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}°C`;
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}

function buildPendingConfirmationLogMessage(params: {
  name: string;
  capabilityId: string;
  desired: number;
  source: PendingTargetObservationSource;
  previousObservedValue?: unknown;
  previousObservedSource?: PendingTargetObservationSource;
  observedValue: unknown;
}): string | null {
  const {
    name,
    capabilityId,
    desired,
    source,
    previousObservedValue,
    previousObservedSource,
    observedValue,
  } = params;
  if (
    previousObservedSource !== undefined
    && Object.is(previousObservedValue, observedValue)
  ) {
    return null;
  }
  if (previousObservedSource !== undefined) {
    return `Target still waiting for ${capabilityId} confirmation for ${name}: `
      + `${formatObservedTarget(previousObservedValue)} -> ${formatObservedTarget(observedValue)} `
      + `via ${source}; expected ${desired}°C`;
  }
  return `Target still waiting for ${capabilityId} confirmation for ${name}: `
    + `observed ${formatObservedTarget(observedValue)} via ${source}; `
    + `expected ${desired}°C`;
}

function maybeLogRepeatedPendingConfirmation(params: {
  pending: PendingTargetCommandState;
  name: string;
  log?: (message: string) => void;
  source: PendingTargetObservationSource;
  observedValue: unknown;
}): void {
  const {
    pending,
    name,
    log,
    source,
    observedValue,
  } = params;
  if (!log) return;
  const nowMs = Date.now();
  if (
    typeof pending.lastWaitingLogAtMs === 'number'
    && (nowMs - pending.lastWaitingLogAtMs) < TARGET_WAITING_LOG_REPEAT_MS
  ) {
    return;
  }
  pending.lastWaitingLogAtMs = nowMs;
  log(
    `Target still waiting for ${pending.capabilityId} confirmation for ${name}: `
    + `observed ${formatObservedTarget(observedValue)} via ${source}; `
    + `expected ${pending.desired}°C`,
  );
}
