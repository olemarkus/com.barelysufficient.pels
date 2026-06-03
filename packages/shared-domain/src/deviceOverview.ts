import {
  buildComparableDeviceReason,
  formatDeviceReasonUserFacing,
  PLAN_REASON_CODES,
  type DeviceReason,
} from './planReasonSemantics';
import {
  isGrayStateDevice,
  isOffLikeState,
  isOnLikeState,
  normalizeDeviceState,
} from './deviceStatePredicates';
import {
  DEVICE_OVERVIEW_ACTIVE,
  DEVICE_OVERVIEW_ACTIVE_CHARGING,
  DEVICE_OVERVIEW_ACTIVE_TEMPERATURE_MANAGED,
  DEVICE_OVERVIEW_CAPACITY_CONTROL_OFF,
  DEVICE_OVERVIEW_CHARGING_PAUSED,
  DEVICE_OVERVIEW_CHARGING_REQUESTED,
  DEVICE_OVERVIEW_INACTIVE,
  DEVICE_OVERVIEW_INACTIVE_CAR_NOT_CHARGING,
  DEVICE_OVERVIEW_INACTIVE_CAR_UNPLUGGED,
  DEVICE_OVERVIEW_INACTIVE_DISCHARGING,
  DEVICE_OVERVIEW_LIMITED,
  DEVICE_OVERVIEW_LOWERED,
  DEVICE_OVERVIEW_LOWERED_BY_PELS,
  DEVICE_OVERVIEW_RESUME_REQUESTED,
  DEVICE_OVERVIEW_RESUMING,
  DEVICE_OVERVIEW_STATE_UNKNOWN,
  DEVICE_OVERVIEW_TURNED_OFF,
  DEVICE_OVERVIEW_TURNED_OFF_BY_PELS,
  DEVICE_OVERVIEW_UNAVAILABLE,
  DEVICE_OVERVIEW_UNKNOWN,
  DEVICE_OVERVIEW_WAITING_FOR_AVAILABLE_POWER,
  deviceOverviewEvBatteryStatus,
  deviceOverviewLimitedToStep,
} from './deviceOverviewStrings';

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

// Secondary text under a Limited chip names the action PELS took. Source of
// truth: notes/ui-terminology.md §"Device state chips". EV chargers map to
// "Charging paused" rather than "Turned off by PELS" so the language matches
// what the user sees on the charger itself; turn-off shed actions on other
// devices read as "Turned off by PELS"; everything else (set_temperature,
// set_step, missing shedAction) reads as "Lowered by PELS".
export const resolveHeldStateActionLabel = (device: DeviceOverviewSnapshot): string => {
  if (isEvChargerDevice(device)) return DEVICE_OVERVIEW_CHARGING_PAUSED;
  if (device.shedAction === 'turn_off') return DEVICE_OVERVIEW_TURNED_OFF_BY_PELS;
  return DEVICE_OVERVIEW_LOWERED_BY_PELS;
};

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
  if (isEvChargerDevice(device)) return DEVICE_OVERVIEW_CHARGING_PAUSED;
  if (device.shedAction === 'set_temperature') return DEVICE_OVERVIEW_LOWERED;
  if (device.shedAction === 'set_step') {
    const targetStepId = getTargetStepId(device);
    return targetStepId ? deviceOverviewLimitedToStep(targetStepId) : DEVICE_OVERVIEW_LIMITED;
  }
  return DEVICE_OVERVIEW_TURNED_OFF;
};

const resolveEvInactiveStateMsg = (evState: string): string => {
  switch (evState) {
    case 'plugged_out':
      return DEVICE_OVERVIEW_INACTIVE_CAR_UNPLUGGED;
    case 'plugged_in':
    case 'plugged_in_paused':
      return DEVICE_OVERVIEW_INACTIVE_CAR_NOT_CHARGING;
    case 'plugged_in_discharging':
      return DEVICE_OVERVIEW_INACTIVE_DISCHARGING;
    default:
      return DEVICE_OVERVIEW_INACTIVE;
  }
};

const resolveEvKeepStateMsg = (device: DeviceOverviewSnapshot, evState: string): string | null => {
  if (device.binaryCommandPending && isOffLikeState(device.currentState)) {
    return DEVICE_OVERVIEW_CHARGING_REQUESTED;
  }
  switch (evState) {
    case 'plugged_in_charging':
      return DEVICE_OVERVIEW_ACTIVE_CHARGING;
    case 'plugged_out':
      return DEVICE_OVERVIEW_INACTIVE_CAR_UNPLUGGED;
    case 'plugged_in':
    case 'plugged_in_paused':
      return DEVICE_OVERVIEW_INACTIVE_CAR_NOT_CHARGING;
    case 'plugged_in_discharging':
      return DEVICE_OVERVIEW_INACTIVE_DISCHARGING;
    default:
      return null;
  }
};

const resolveEvStateMsg = (device: DeviceOverviewSnapshot): string | null => {
  if (!isEvChargerDevice(device)) return null;
  const evState = normalizeDeviceState(device.evChargingState);

  if (device.plannedState === 'shed') return DEVICE_OVERVIEW_CHARGING_PAUSED;
  if (device.plannedState === 'inactive') return resolveEvInactiveStateMsg(evState);
  if (device.plannedState === 'keep') return resolveEvKeepStateMsg(device, evState);
  return null;
};

const resolveKeepStateMsg = (device: DeviceOverviewSnapshot): string => {
  const evStateMsg = resolveEvStateMsg(device);
  if (evStateMsg) return evStateMsg;
  if (device.binaryCommandPending && isOffLikeState(device.currentState)) {
    return DEVICE_OVERVIEW_RESUME_REQUESTED;
  }
  if (isOffLikeState(device.currentState)) return DEVICE_OVERVIEW_RESUMING;
  if (normalizeDeviceState(device.currentState) === 'not_applicable') {
    return DEVICE_OVERVIEW_ACTIVE_TEMPERATURE_MANAGED;
  }
  return DEVICE_OVERVIEW_ACTIVE;
};

const resolveStateMsg = (device: DeviceOverviewSnapshot): string => {
  if (device.controllable === false) return DEVICE_OVERVIEW_CAPACITY_CONTROL_OFF;
  if (isGrayStateDevice(device)) {
    return device.available === false ? DEVICE_OVERVIEW_UNAVAILABLE : DEVICE_OVERVIEW_STATE_UNKNOWN;
  }
  const evStateMsg = resolveEvStateMsg(device);
  if (evStateMsg) return evStateMsg;
  if (isKeepStateSteppedModeTransition(device)) {
    return `Active (${getSteppedModeTransitionText(device)})`;
  }
  if (device.plannedState === 'shed') return resolveShedStateMsg(device);
  if (device.plannedState === 'inactive') return DEVICE_OVERVIEW_INACTIVE;
  if (device.plannedState === 'keep') return resolveKeepStateMsg(device);
  return DEVICE_OVERVIEW_UNKNOWN;
};

const formatEvSocStatus = (
  stateOfCharge: DeviceOverviewSnapshot['stateOfCharge'],
): string | null => {
  if (!stateOfCharge || stateOfCharge.status === 'unknown' || stateOfCharge.status === 'invalid') {
    return null;
  }
  return deviceOverviewEvBatteryStatus(stateOfCharge.percent, stateOfCharge.status === 'stale');
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
  return DEVICE_OVERVIEW_UNKNOWN;
};

export const getDeviceOverviewExpectedPowerKw = (device: DeviceOverviewSnapshot): number | undefined => (
  isSteppedLoadDevice(device) ? (device.planningPowerKw ?? device.expectedPowerKw) : device.expectedPowerKw
);

const appendOverviewStatus = (statusMsg: string, extraStatus: string | null): string => {
  if (!extraStatus) return statusMsg;
  if (statusMsg === '' || statusMsg === DEVICE_OVERVIEW_WAITING_FOR_AVAILABLE_POWER) return extraStatus;
  // Em-dash separator matches the device-card status copy convention. Spec:
  // notes/ui-terminology.md:9, TODO #8 (2026-05-16).
  return `${statusMsg} — ${extraStatus}`;
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
      ? DEVICE_OVERVIEW_WAITING_FOR_AVAILABLE_POWER
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
