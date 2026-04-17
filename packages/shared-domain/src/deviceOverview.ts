import { buildComparablePlanReason } from './planReasonSemantics.js';

export type DeviceOverviewSnapshot = {
  currentState?: string;
  plannedState?: string;
  controlModel?: 'temperature_target' | 'binary_power' | 'stepped_load';
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  reason?: string;
  controllable?: boolean;
  available?: boolean;
  shedAction?: 'turn_off' | 'set_temperature' | 'set_step';
  shedTemperature?: number | null;
  currentTarget?: unknown;
  reportedStepId?: string;
  targetStepId?: string;
  selectedStepId?: string;
  desiredStepId?: string;
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: 'reported' | 'assumed' | 'profile_default';
  binaryCommandPending?: boolean;
  observationStale?: boolean;
};

export type DeviceOverviewStrings = {
  powerMsg: string | null;
  stateMsg: string;
  usageMsg: string;
  statusMsg: string;
};

const normalizeState = (value: string | undefined): string => (value || '').trim().toLowerCase();

const isSteppedLoadDevice = (device: DeviceOverviewSnapshot): boolean => device.controlModel === 'stepped_load';

const isGrayStateDevice = (device: DeviceOverviewSnapshot): boolean => {
  if (device.available === false) return true;
  if (device.observationStale === true) return true;
  const currentState = normalizeState(device.currentState);
  return currentState === 'unknown' || currentState === 'disappeared';
};

const isOnLikeState = (value: string | undefined): boolean => {
  const normalized = normalizeState(value);
  if (!normalized) return false;
  return normalized !== 'off'
    && normalized !== 'unknown'
    && normalized !== 'not_applicable'
    && normalized !== 'disappeared';
};

const isOffLikeState = (state?: string): boolean => {
  const normalized = normalizeState(state);
  return normalized === 'off' || normalized === 'unknown';
};

export const getDeviceOverviewReportedStepId = (device: DeviceOverviewSnapshot): string | undefined => (
  (device.actualStepSource === 'reported' ? device.actualStepId : undefined) ?? device.reportedStepId
);

const getTargetStepId = (device: DeviceOverviewSnapshot): string | undefined => (
  device.targetStepId ?? device.desiredStepId
);

const getSteppedModeTransitionText = (device: DeviceOverviewSnapshot): string | null => {
  const reportedStepId = getDeviceOverviewReportedStepId(device);
  const targetStepId = getTargetStepId(device);

  if (!reportedStepId || !targetStepId || reportedStepId === targetStepId) return null;
  return `${reportedStepId} → ${targetStepId}`;
};

export const isDeviceOverviewSteppedModeTransition = (device: DeviceOverviewSnapshot): boolean => (
  isSteppedLoadDevice(device)
  && !isGrayStateDevice(device)
  && isOnLikeState(device.currentState)
  && getSteppedModeTransitionText(device) !== null
);

const isKeepStateSteppedModeTransition = (device: DeviceOverviewSnapshot): boolean => (
  device.plannedState === 'keep' && isDeviceOverviewSteppedModeTransition(device)
);

const getSteppedUsageStepText = (device: DeviceOverviewSnapshot): string | null => {
  const reportedStepId = getDeviceOverviewReportedStepId(device);
  const targetStepId = getTargetStepId(device);

  if (reportedStepId) {
    if (targetStepId && targetStepId !== reportedStepId) {
      return `reported: ${reportedStepId} / target: ${targetStepId}`;
    }
    return `reported: ${reportedStepId}`;
  }

  return targetStepId ? `target: ${targetStepId}` : null;
};

const resolvePlannedPowerState = (
  device: DeviceOverviewSnapshot,
  currentPowerRaw: string,
  currentPower: string,
): string => {
  if (currentPowerRaw === 'not_applicable') return currentPower;

  const isMinTempActive = device.shedAction === 'set_temperature'
    && typeof device.shedTemperature === 'number'
    && device.currentTarget === device.shedTemperature;

  switch (device.plannedState) {
    case 'shed':
      return device.shedAction === 'set_temperature' ? 'on' : 'off';
    case 'inactive':
      return currentPowerRaw === 'unknown' ? currentPower : 'off';
    case 'keep':
      return isMinTempActive ? 'on' : currentPower;
    default:
      return device.plannedState || currentPower;
  }
};

const resolveShedStateMsg = (device: DeviceOverviewSnapshot): string => {
  if (device.shedAction === 'set_temperature') return 'Shed (lowered temperature)';
  if (device.shedAction === 'set_step') {
    return getTargetStepId(device) ? `Shed to ${getTargetStepId(device)}` : 'Shed (reduced step)';
  }
  return 'Shed (powered off)';
};

const resolveKeepStateMsg = (device: DeviceOverviewSnapshot): string => {
  if (device.binaryCommandPending && isOffLikeState(device.currentState)) return 'Restore requested';
  if (isOffLikeState(device.currentState)) return 'Restoring';
  if (normalizeState(device.currentState) === 'not_applicable') return 'Active (temperature-managed)';
  return 'Active';
};

const resolveStateMsg = (device: DeviceOverviewSnapshot): string => {
  if (device.controllable === false) return 'Capacity control off';
  if (isGrayStateDevice(device)) {
    return device.available === false ? 'Unavailable' : 'State unknown';
  }
  if (isKeepStateSteppedModeTransition(device)) {
    return `Active (${getSteppedModeTransitionText(device)})`;
  }
  if (device.plannedState === 'shed') return resolveShedStateMsg(device);
  if (device.plannedState === 'inactive') return 'Inactive';
  if (device.plannedState === 'keep') return resolveKeepStateMsg(device);
  return 'Unknown';
};

const formatActivePlanStatusReason = (reason: string): string => {
  const meterSettlingMatch = reason.match(/^meter settling \((.+)\)$/);
  if (meterSettlingMatch) {
    return `waiting for meter to settle (${meterSettlingMatch[1]})`;
  }

  const headroomRestoreMatch = reason.match(/^headroom cooldown \((.+); recent PELS restore\)$/);
  if (headroomRestoreMatch) {
    return `stabilizing after recent PELS restore (${headroomRestoreMatch[1]})`;
  }

  const headroomShedMatch = reason.match(/^headroom cooldown \((.+); recent PELS shed\)$/);
  if (headroomShedMatch) {
    return `stabilizing after recent PELS shed (${headroomShedMatch[1]})`;
  }

  const stepDownMatch = reason.match(/^headroom cooldown \((.+); usage (.+)\)$/);
  if (stepDownMatch) {
    return `stabilizing after recent step-down (${stepDownMatch[1]}; usage ${stepDownMatch[2]})`;
  }

  return reason;
};

const formatUsageText = (params: {
  measuredKw?: number;
  expectedKw?: number;
}): string => {
  const { measuredKw, expectedKw } = params;
  const hasMeasured = typeof measuredKw === 'number' && Number.isFinite(measuredKw);
  const hasExpected = typeof expectedKw === 'number' && Number.isFinite(expectedKw);
  if (hasExpected && hasMeasured) {
    return `Measured: ${measuredKw.toFixed(2)} kW / Expected: ${expectedKw.toFixed(2)} kW`;
  }
  if (hasExpected) return `Expected: ${expectedKw.toFixed(2)} kW`;
  if (hasMeasured) return `Measured: ${measuredKw.toFixed(2)} kW`;
  return 'Unknown';
};

export const getDeviceOverviewExpectedPowerKw = (device: DeviceOverviewSnapshot): number | undefined => (
  isSteppedLoadDevice(device) ? (device.planningPowerKw ?? device.expectedPowerKw) : device.expectedPowerKw
);

export const formatDeviceOverview = (device: DeviceOverviewSnapshot): DeviceOverviewStrings => {
  const currentPowerRaw = normalizeState(device.currentState) || 'unknown';
  let powerMsg: string | null = null;
  if (!isSteppedLoadDevice(device) && currentPowerRaw !== 'not_applicable') {
    const currentPower = currentPowerRaw;
    const plannedPowerState = resolvePlannedPowerState(device, currentPowerRaw, currentPower);
    powerMsg = plannedPowerState !== currentPower ? `${currentPower} → ${plannedPowerState}` : plannedPowerState;
  }

  let usageMsg = formatUsageText({
    measuredKw: device.measuredPowerKw,
    expectedKw: getDeviceOverviewExpectedPowerKw(device),
  });
  if (isSteppedLoadDevice(device)) {
    const stepText = getSteppedUsageStepText(device);
    if (stepText) usageMsg = `${usageMsg} (${stepText})`;
  }

  let statusMsg = 'Waiting for headroom';
  if (device.reason) {
    statusMsg = device.plannedState === 'keep' && !isKeepStateSteppedModeTransition(device)
      ? formatActivePlanStatusReason(device.reason)
      : device.reason;
  }

  return {
    powerMsg,
    stateMsg: resolveStateMsg(device),
    usageMsg,
    statusMsg,
  };
};

export const buildDeviceOverviewTransitionSignature = (
  overview: Pick<DeviceOverviewStrings, 'powerMsg' | 'stateMsg'> & {
    reason?: string;
    reportedStepId?: string;
    targetStepId?: string;
  },
): string => (
  JSON.stringify({
    powerMsg: overview.powerMsg,
    stateMsg: overview.stateMsg,
    reason: buildComparablePlanReason(overview.reason),
    reportedStepId: overview.reportedStepId ?? null,
    targetStepId: overview.targetStepId ?? null,
  })
);
