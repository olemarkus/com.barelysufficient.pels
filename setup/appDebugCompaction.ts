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
  EnergyContainerValue,
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

/**
 * One reported field of the energy container, or `null` to omit it.
 *
 * A non-finite number is carried as its literal TEXT rather than as a number.
 * `safeJsonStringify` is `JSON.stringify`, which renders `NaN`/`Infinity` as
 * `null` — the same thing this dump emits for a genuinely declared `null`, so
 * the two would be indistinguishable in exactly the artefact whose job is to
 * report what the device declared. Gating them away (the other obvious option)
 * trades that ambiguity for a worse one: an absent key reads as "the device
 * declared nothing here", when in fact it declared something broken, and a
 * broken declaration is a finding rather than noise.
 */
const resolveEnergyContainerValue = (value: unknown): { value: EnergyContainerValue } | null => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { value };
  if (typeof value === 'number') return { value: Number.isFinite(value) ? value : String(value) };
  return null;
};

/**
 * The energy container's own PRIMITIVE fields, copied verbatim — the role
 * declaration (`cumulative`, `homeBattery`, `cumulative*Capability`,
 * `meterPower*Capability`). Primitives only: `approximation` and any other
 * nested object is already covered by the resolved values below, and copying
 * nested structures wholesale would let one device balloon the dump.
 */
const compactEnergyContainer = (
  energy: UnknownRecord,
): Record<string, EnergyContainerValue> => Object.fromEntries(
  Object.entries(energy).flatMap(([key, raw]) => {
    const resolved = resolveEnergyContainerValue(raw);
    return resolved === null ? [] : [[key, resolved.value] as const];
  }),
);

export const buildEnergyDebugPayload = (device: HomeyDeviceLike): EnergyDebugPayload | null => {
  const energy = resolveEnergyContainer(device);
  if (!energy) return null;

  // No "every approximation value is absent → null" bail-out: that dropped the
  // whole section for exactly the devices whose ROLE we most need to read. A
  // meter declares `cumulative`/`cumulative*Capability` and no `approximation`
  // at all, so it used to dump as `unavailable` and say nothing. A container
  // that exists is always worth reporting; only its total absence is `null`.
  const onoff = resolveOnOffValue(device);
  // The approximation/`W` values keep reading the RESOLVED container only —
  // that precedence is shared with `devicePowerEstimate`, and is not this
  // change's to alter. Only the reported role declaration covers both containers.
  const values = resolveApproximationValues(energy);
  const inference = inferExpectedW({ onoff, values });
  const record = device as unknown as UnknownRecord;
  return {
    onoff,
    containers: {
      energyObj: isRecord(record.energyObj) ? compactEnergyContainer(record.energyObj) : null,
      energy: isRecord(record.energy) ? compactEnergyContainer(record.energy) : null,
    },
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
