import type {
  TargetDeviceSnapshot,
  TemperatureObservation,
} from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';

export const TARGET_TEMPERATURE_CAPABILITY_ID = 'target_temperature';

export function resolveTemperatureObservation(params: {
  currentTemperature: number | undefined;
  targets: TargetDeviceSnapshot['targets'];
}): TemperatureObservation | undefined {
  const target = params.targets.find((entry) => entry.id === TARGET_TEMPERATURE_CAPABILITY_ID);
  if (!target || params.currentTemperature === undefined || !isFiniteNumber(target.value)) return undefined;
  return {
    currentTemperature: params.currentTemperature,
    target: { ...target, id: TARGET_TEMPERATURE_CAPABILITY_ID, value: target.value },
  };
}

export function resolveTargetDeviceType(
  temperature?: TemperatureObservation,
): TargetDeviceSnapshot['deviceType'] {
  return temperature ? 'temperature' : 'onoff';
}

/** Remove the complete temperature facet while leaving every other device facet intact. */
export function removeTemperatureObservation(snapshot: TransportDeviceSnapshot): boolean {
  const hadTemperature = snapshot.temperature !== undefined
    || snapshot.targets.some((target) => target.id === TARGET_TEMPERATURE_CAPABILITY_ID)
    || snapshot.deviceType === 'temperature';
  if (!hadTemperature) return false;
  const mutableSnapshot = snapshot;
  delete mutableSnapshot.temperature;
  mutableSnapshot.targets = snapshot.targets.filter((target) => target.id !== TARGET_TEMPERATURE_CAPABILITY_ID);
  if (snapshot.deviceType === 'temperature') mutableSnapshot.deviceType = 'onoff';
  return true;
}

/** Apply a finite measurement only to an already-admitted atomic facet. */
export function updateTemperatureMeasurement(
  snapshot: TransportDeviceSnapshot,
  value: number,
): boolean {
  if (!snapshot.temperature) return false;
  if (Object.is(snapshot.temperature.currentTemperature, value)) return false;
  const mutableSnapshot = snapshot;
  mutableSnapshot.temperature = { ...snapshot.temperature, currentTemperature: value };
  return true;
}

/** Apply a finite exact target only to an already-admitted atomic facet. */
export function updateTemperatureTarget(
  snapshot: TransportDeviceSnapshot,
  value: number,
): { changed: boolean; previousValue?: number } {
  if (!snapshot.temperature) return { changed: false };
  const previousValue = snapshot.temperature.target.value;
  if (Object.is(previousValue, value)) return { changed: false, previousValue };
  const target = { ...snapshot.temperature.target, value };
  const mutableSnapshot = snapshot;
  mutableSnapshot.temperature = { ...snapshot.temperature, target };
  mutableSnapshot.targets = snapshot.targets.map((entry) => (
    entry.id === TARGET_TEMPERATURE_CAPABILITY_ID ? target : entry
  ));
  return { changed: true, previousValue };
}

export function preserveTemperatureAcrossPartialDeviceUpdate(params: {
  device: HomeyDeviceLike;
  previous: TransportDeviceSnapshot;
  parsed: TransportDeviceSnapshot;
}): TransportDeviceSnapshot {
  const { device, previous, parsed } = params;
  const temperature = resolvePreservedTemperature(device, previous, parsed);
  if (!temperature) return parsed;
  return {
    ...parsed,
    deviceType: 'temperature',
    targets: [
      ...parsed.targets.filter((target) => target.id !== TARGET_TEMPERATURE_CAPABILITY_ID),
      temperature.target,
    ],
    temperature,
  };
}

function resolvePreservedTemperature(
  device: HomeyDeviceLike,
  previous: TransportDeviceSnapshot,
  parsed: TransportDeviceSnapshot,
): TemperatureObservation | undefined {
  const previousTemperature = previous.temperature;
  if (!previousTemperature || parsed.temperature) return undefined;
  const capabilities = device.capabilities ?? [];
  if (!hasTemperatureCapabilityPair(capabilities)) return undefined;
  const capabilityObj = device.capabilitiesObj ?? {};
  const measureEntry = capabilityObj.measure_temperature;
  const targetEntry = capabilityObj.target_temperature;
  const measureValue = resolvePartialValue(
    measureEntry?.value,
    measureEntry !== undefined,
    previousTemperature.currentTemperature,
  );
  const targetValue = resolvePartialValue(
    targetEntry?.value,
    targetEntry !== undefined,
    previousTemperature.target.value,
  );
  if (measureValue === undefined || targetValue === undefined) return undefined;
  const target = {
    ...previousTemperature.target,
    ...(targetEntry?.units ? { unit: targetEntry.units } : {}),
    value: targetValue,
  };
  return {
    currentTemperature: measureValue,
    target,
  };
}

function hasTemperatureCapabilityPair(capabilities: readonly string[]): boolean {
  return capabilities.includes('measure_temperature')
    && capabilities.includes(TARGET_TEMPERATURE_CAPABILITY_ID);
}

function resolvePartialValue(
  value: unknown,
  wasReported: boolean,
  fallback: number,
): number | undefined {
  const candidate = wasReported ? value : fallback;
  return isFiniteNumber(candidate) ? candidate : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
