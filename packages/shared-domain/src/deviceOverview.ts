import {
  buildComparableDeviceReason,
  formatDeviceReasonUserFacing,
  PLAN_REASON_CODES,
  type DeviceReason,
} from './planReasonSemantics.js';
import {
  isGrayStateDevice,
  isOffLikeState,
  isOnLikeState,
  normalizeDeviceState,
} from './deviceStatePredicates.js';

export type DeviceOverviewSnapshot = {
  currentState?: string;
  plannedState?: string;
  controlModel?: 'temperature_target' | 'binary_power' | 'stepped_load';
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  evChargingState?: string;
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  reason: DeviceReason;
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
  stateOfCharge?: {
    percent: number;
    status: 'unknown' | 'fresh' | 'stale' | 'invalid';
  };
};

export type DeviceOverviewStrings = {
  powerMsg: string | null;
  stateMsg: string;
  usageMsg: string;
  statusMsg: string;
};

const isSteppedLoadDevice = (device: DeviceOverviewSnapshot): boolean => (
  device.controlModel === 'stepped_load'
);
const isEvChargerDevice = (device: DeviceOverviewSnapshot): boolean => (
  device.controlCapabilityId === 'evcharger_charging'
);

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
  if (isEvChargerDevice(device)) return 'Shed (charging paused)';
  if (device.shedAction === 'set_temperature') return 'Shed (lowered temperature)';
  if (device.shedAction === 'set_step') {
    return getTargetStepId(device) ? `Shed to ${getTargetStepId(device)}` : 'Shed (reduced step)';
  }
  return 'Shed (powered off)';
};

const resolveEvInactiveStateMsg = (evState: string): string => {
  switch (evState) {
    case 'plugged_out':
      return 'Inactive (car unplugged)';
    case 'plugged_in':
    case 'plugged_in_paused':
      return 'Inactive (car not charging)';
    case 'plugged_in_discharging':
      return 'Inactive (discharging)';
    default:
      return 'Inactive';
  }
};

const resolveEvKeepStateMsg = (device: DeviceOverviewSnapshot, evState: string): string | null => {
  if (device.binaryCommandPending && isOffLikeState(device.currentState)) return 'Charging requested';
  switch (evState) {
    case 'plugged_in_charging':
      return 'Active (charging)';
    case 'plugged_out':
      return 'Inactive (car unplugged)';
    case 'plugged_in':
    case 'plugged_in_paused':
      return 'Inactive (car not charging)';
    case 'plugged_in_discharging':
      return 'Inactive (discharging)';
    default:
      return null;
  }
};

const resolveEvStateMsg = (device: DeviceOverviewSnapshot): string | null => {
  if (!isEvChargerDevice(device)) return null;
  const evState = normalizeDeviceState(device.evChargingState);

  if (device.plannedState === 'shed') return 'Shed (charging paused)';
  if (device.plannedState === 'inactive') return resolveEvInactiveStateMsg(evState);
  if (device.plannedState === 'keep') return resolveEvKeepStateMsg(device, evState);
  return null;
};

const resolveKeepStateMsg = (device: DeviceOverviewSnapshot): string => {
  const evStateMsg = resolveEvStateMsg(device);
  if (evStateMsg) return evStateMsg;
  if (device.binaryCommandPending && isOffLikeState(device.currentState)) return 'Restore requested';
  if (isOffLikeState(device.currentState)) return 'Restoring';
  if (normalizeDeviceState(device.currentState) === 'not_applicable') return 'Active (temperature-managed)';
  return 'Active';
};

const resolveStateMsg = (device: DeviceOverviewSnapshot): string => {
  if (device.controllable === false) return 'Capacity control off';
  if (isGrayStateDevice(device)) {
    return device.available === false ? 'Unavailable' : 'State unknown';
  }
  const evStateMsg = resolveEvStateMsg(device);
  if (evStateMsg) return evStateMsg;
  if (isKeepStateSteppedModeTransition(device)) {
    return `Active (${getSteppedModeTransitionText(device)})`;
  }
  if (device.plannedState === 'shed') return resolveShedStateMsg(device);
  if (device.plannedState === 'inactive') return 'Inactive';
  if (device.plannedState === 'keep') return resolveKeepStateMsg(device);
  return 'Unknown';
};

const formatEvSocStatus = (
  stateOfCharge: DeviceOverviewSnapshot['stateOfCharge'],
): string | null => {
  if (!stateOfCharge || stateOfCharge.status === 'unknown' || stateOfCharge.status === 'invalid') {
    return null;
  }
  const staleSuffix = stateOfCharge.status === 'stale' ? ', stale' : '';
  return `EV battery: ${stateOfCharge.percent} %${staleSuffix}`;
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

const WAITING_FOR_AVAILABLE_POWER = 'Waiting for available power';

const appendOverviewStatus = (statusMsg: string, extraStatus: string | null): string => {
  if (!extraStatus) return statusMsg;
  if (statusMsg === '' || statusMsg === WAITING_FOR_AVAILABLE_POWER) return extraStatus;
  return `${statusMsg} - ${extraStatus}`;
};

export const formatDeviceOverview = (device: DeviceOverviewSnapshot): DeviceOverviewStrings => {
  const currentPowerRaw = normalizeDeviceState(device.currentState) || 'unknown';
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

  const statusMsg = appendOverviewStatus(
    device.reason.code === PLAN_REASON_CODES.none
      ? WAITING_FOR_AVAILABLE_POWER
      : formatDeviceReasonUserFacing(device.reason),
    formatEvSocStatus(device.stateOfCharge),
  );

  return {
    powerMsg,
    stateMsg: resolveStateMsg(device),
    usageMsg,
    statusMsg,
  };
};

const normalizeSignatureNumber = (value: number | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const isMinTemperatureRestoreActive = (device: DeviceOverviewSnapshot): boolean => (
  device.shedAction === 'set_temperature'
  && typeof device.shedTemperature === 'number'
  && device.currentTarget === device.shedTemperature
);

export const buildDeviceOverviewTransitionSignature = (
  device: DeviceOverviewSnapshot,
): string => (
  JSON.stringify({
    currentState: normalizeDeviceState(device.currentState) || 'unknown',
    plannedState: device.plannedState ?? null,
    controlModel: device.controlModel ?? null,
    controllable: device.controllable === false,
    available: device.available === false,
    observationStale: device.observationStale === true,
    binaryCommandPending: device.binaryCommandPending === true,
    shedAction: device.shedAction ?? null,
    minTemperatureRestoreActive: isMinTemperatureRestoreActive(device),
    measuredPowerKw: normalizeSignatureNumber(device.measuredPowerKw),
    expectedPowerKw: normalizeSignatureNumber(getDeviceOverviewExpectedPowerKw(device)),
    reason: buildComparableDeviceReason(device.reason),
    reportedStepId: getDeviceOverviewReportedStepId(device) ?? null,
    targetStepId: getTargetStepId(device) ?? null,
  })
);
