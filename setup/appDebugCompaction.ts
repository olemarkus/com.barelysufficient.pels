import type {
  DeviceCalibration,
  PowerCalibrationSnapshot,
} from '../packages/contracts/src/powerCalibration';
import { formatDeviceReason } from '../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan } from '../lib/plan/planTypes';
import { isTemperaturePlanDevice } from '../lib/plan/planTemperatureDevice';
import type { HomeyDeviceLike } from '../lib/utils/types';
import type {
  MeasuredPowerObservedProbe,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorProbe,
  TargetDeviceSnapshot,
  TemperatureObservedProbe,
} from '../packages/contracts/src/types';
import type {
  DebugSection,
  EnergyApproximationValues,
  EnergyDebugPayload,
  EnergyInference,
  HomeyCapabilitySummary,
  HomeyDeviceSummary,
  PelsPlanDeviceSummary,
  PelsTargetSnapshotSummary,
  UnknownRecord,
} from './appDebugTypes';
import {
  asFiniteNumber,
  asString,
  asTimestampString,
  isRecord,
} from './appDebugPrimitives';

const resolveEnergyContainer = (device: HomeyDeviceLike): UnknownRecord | null => {
  const record = device as unknown as UnknownRecord;
  if (isRecord(record.energyObj)) return record.energyObj;
  if (isRecord(record.energy)) return record.energy;
  return null;
};

const resolveOnOffValue = (device: HomeyDeviceLike): boolean | null => {
  const value = device.capabilitiesObj?.onoff?.value;
  return typeof value === 'boolean' ? value : null;
};

const resolveApproximationValues = (energy: UnknownRecord): EnergyApproximationValues => {
  const approx = isRecord(energy.approximation) ? energy.approximation : null;
  return {
    usageOnW: approx ? asFiniteNumber(approx.usageOn) : null,
    usageOffW: approx ? asFiniteNumber(approx.usageOff) : null,
    energyW: asFiniteNumber(energy.W),
  };
};

const inferExpectedW = (params: {
  onoff: boolean | null;
  values: EnergyApproximationValues;
}): EnergyInference => {
  const { onoff, values } = params;
  const {
    usageOnW,
    usageOffW,
    energyW,
  } = values;

  if (usageOnW !== null && usageOffW !== null) {
    const deltaW = Math.max(0, usageOnW - usageOffW);
    if (deltaW > 0) return { inferredExpectedW: deltaW, inferredSource: 'approximation_delta' };
  }
  if (usageOnW !== null) return { inferredExpectedW: usageOnW, inferredSource: 'approximation_on' };
  if (energyW !== null && onoff !== false) return { inferredExpectedW: energyW, inferredSource: 'energy_w' };
  return { inferredExpectedW: null, inferredSource: null };
};

export const buildEnergyDebugPayload = (device: HomeyDeviceLike): EnergyDebugPayload | null => {
  const energy = resolveEnergyContainer(device);
  if (!energy) return null;

  const onoff = resolveOnOffValue(device);
  const values = resolveApproximationValues(energy);
  if (
    values.usageOnW === null
    && values.usageOffW === null
    && values.energyW === null
  ) {
    return null;
  }

  const inference = inferExpectedW({ onoff, values });
  return {
    onoff,
    ...values,
    ...inference,
  };
};

export const buildAvailableSection = <T>(payload: T): DebugSection<T> => ({
  available: true,
  payload,
});

export const buildUnavailableSection = <T>(error?: string): DebugSection<T> => ({
  available: false,
  payload: null,
  ...(error ? { error } : {}),
});

const compactCapability = (value: unknown): HomeyCapabilitySummary => {
  if (!isRecord(value)) return {};
  return {
    ...(Object.prototype.hasOwnProperty.call(value, 'value') ? { value: value.value } : {}),
    ...(asString(value.units) ? { units: asString(value.units) } : {}),
    ...(asTimestampString(value.lastUpdated) ? { lastUpdated: asTimestampString(value.lastUpdated) } : {}),
    ...(typeof value.setable === 'boolean' ? { setable: value.setable } : {}),
    ...(typeof value.getable === 'boolean' ? { getable: value.getable } : {}),
  };
};

export const compactHomeyDevice = (device: HomeyDeviceLike): HomeyDeviceSummary => {
  const record = device as unknown as UnknownRecord;
  const zone = typeof device.zone === 'string'
    ? device.zone
    : asString((device.zone as UnknownRecord | undefined)?.name) ?? asString(record.zoneName);
  const capabilityValues = Object.fromEntries(
    Object.entries(device.capabilitiesObj || {}).map(([capabilityId, capabilityValue]) => [
      capabilityId,
      compactCapability(capabilityValue),
    ]),
  );
  return {
    id: device.id,
    name: device.name,
    class: device.class,
    ...(asString(record.driverId) ? { driverId: asString(record.driverId) } : {}),
    ...(typeof device.available === 'boolean' ? { available: device.available } : {}),
    ...(typeof record.ready === 'boolean' ? { ready: record.ready } : {}),
    ...(zone ? { zone } : {}),
    ...(asTimestampString(record.lastSeenAt) ? { lastSeenAt: asTimestampString(record.lastSeenAt) } : {}),
    capabilities: Array.isArray(device.capabilities) ? device.capabilities : [],
    capabilityValues,
  };
};

export const filterRelevantSettings = (settings: unknown): Record<string, unknown> | null => {
  if (!isRecord(settings)) return null;
  const filtered = Object.fromEntries(
    Object.entries(settings).filter(([key]) => !key.startsWith('zb_')),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
};

export const compactPelsTargetSnapshot = (
  // Probe-widened: this debug seam dumps the raw observed temperature for EVERY
  // device (incl. non-temperature `deviceType` devices that carry a
  // `measure_temperature` reading), so it reads through the owner probe rather
  // than `hasObservedTemperature` — a plain `TargetDeviceSnapshot` (from
  // `getSnapshot()`) stays assignable because the probe field is optional.
  snapshot: (TargetDeviceSnapshot & TemperatureObservedProbe & MeasuredPowerObservedProbe
    & SteppedLoadDescriptorProbe & ReportedStepObservedProbe) | null,
): PelsTargetSnapshotSummary | null => {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    name: snapshot.name,
    deviceType: snapshot.deviceType,
    controlModel: snapshot.controlModel,
    controlCapabilityId: snapshot.controlCapabilityId,
    controlAdapter: snapshot.controlAdapter,
    capabilities: snapshot.capabilities,
    steppedLoadProfile: snapshot.steppedLoadProfile,
    suggestedSteppedLoadProfile: snapshot.suggestedSteppedLoadProfile,
    targetPowerConfig: snapshot.targetPowerConfig,
    binaryControl: snapshot.binaryControl,
    currentTemperature: snapshot.currentTemperature,
    targets: snapshot.targets,
    powerKw: snapshot.powerKw,
    expectedPowerKw: snapshot.expectedPowerKw,
    measuredPowerKw: snapshot.measuredPowerKw,
    reportedStepId: snapshot.reportedStepId,
    controllable: snapshot.controllable,
    managed: snapshot.managed,
    available: snapshot.available,
    lastUpdated: snapshot.lastUpdated,
  };
};

export const compactPelsPlanDevice = (
  device: DevicePlan['devices'][number] | null,
): PelsPlanDeviceSummary | null => {
  if (!device) return null;
  return {
    id: device.id,
    name: device.name,
    currentState: device.currentState,
    plannedState: device.plannedState,
    currentTarget: isTemperaturePlanDevice(device) ? device.currentTarget : null,
    plannedTarget: isTemperaturePlanDevice(device) ? device.plannedTarget : undefined,
    reason: formatDeviceReason(device.reason),
    controllable: device.controllable,
    stepPowerCalibration: device.stepPowerCalibration,
    pendingTargetCommand: device.pendingTargetCommand,
  };
};

export const getPelsPowerCalibration = (
  snapshot: PowerCalibrationSnapshot | null | undefined,
  deviceId: string,
): DeviceCalibration | null => snapshot?.devices[deviceId] ?? null;
