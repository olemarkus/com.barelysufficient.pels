import type {
  TargetDeviceSnapshot,
  TemperatureObservation,
} from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';

export const TARGET_TEMPERATURE_CAPABILITY_ID = 'target_temperature';

/** Admit the atomic temperature facet, or refuse it. */
export function resolveTemperatureObservation(
  currentTemperature: number | undefined,
  targets: TargetDeviceSnapshot['targets'],
): TemperatureObservation | undefined {
  const target = targets.find((entry) => entry.id === TARGET_TEMPERATURE_CAPABILITY_ID);
  if (!target || currentTemperature === undefined || !isFiniteNumber(target.value)) return undefined;
  return {
    currentTemperature,
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
