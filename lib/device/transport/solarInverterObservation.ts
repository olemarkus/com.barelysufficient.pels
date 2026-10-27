import { asUnknownRecord } from '../../../packages/shared-domain/src/recordGuards';
import type { InverterControlSurface, InverterObservation } from '../../../packages/contracts/src/inverterControl';
import type { HomeyDeviceLike } from '../../utils/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { isSolarPanelDevice } from '../managerEnergy';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';

type NumberReport = InverterObservation['limit'];
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
// Like battery claim reports, realtime modes are stamped on arrival, after Homey's source time.
const MODE_STAMP_SKEW_MS = 5_000;

function productionRange(cap: DeviceCapabilityMap[string] | undefined): { maxW: number; stepW: number } | null {
  if (cap?.setable !== true || !isFiniteNumber(cap.max) || cap.max <= 0) return null;
  const stepW = cap.step === undefined ? 1 : cap.step;
  if (!isFiniteNumber(stepW) || stepW <= 0 || stepW > cap.max) return null;
  if (cap.min !== undefined && (!isFiniteNumber(cap.min) || cap.min > 0)) return null;
  if (cap.excludeMax !== undefined && cap.excludeMax !== 0) return null;
  return { maxW: cap.max, stepW };
}

function controlMode(entry: DeviceCapabilityMap[string] | undefined):
  { mode: 'direct' } | { mode: 'switchable'; modeValues: readonly string[] } | null {
  if (entry === undefined) return { mode: 'direct' };
  const values = asUnknownRecord(entry)?.values;
  const ids = Array.isArray(values) ? values.map((value: unknown) => asUnknownRecord(value)?.id) : [];
  return entry.setable === true && ids.every((id): id is string => typeof id === 'string' && id.length > 0)
    && ids.includes('device') && ids.includes('homey') ? { mode: 'switchable', modeValues: ids } : null;
}

/** Accept only the standard production cap, with an explicit physical maximum. */
export function resolveInverterControl(
  device: HomeyDeviceLike, values: Readonly<Partial<DeviceCapabilityMap>>,
): InverterControlSurface | null {
  if (!isSolarPanelDevice(device) || !getDeviceAdapter(device).supportsProductionLimits) return null;
  const capabilities = device.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes('target_power')
    || !capabilities.includes('measure_power')) return null;
  const range = productionRange(values.target_power);
  const hasMode = capabilities.includes('target_power_mode');
  if (hasMode && values.target_power_mode === undefined) return null;
  const mode = controlMode(hasMode ? values.target_power_mode : undefined);
  if (!range || !mode) return null;
  return { ...range, ...mode, authority: 'limit_and_release' };
}

function modeReport(
  surface: InverterControlSurface, entry: DeviceCapabilityMap[string] | undefined,
  previous: InverterObservation['mode'] | undefined,
): InverterObservation['mode'] | undefined {
  if (surface.mode === 'direct') return { kind: 'direct' };
  const stamp = toCapabilityTimestampMs(entry?.lastUpdated);
  if (typeof entry?.value !== 'string' || entry.value.length === 0 || stamp === undefined) return previous;
  if (previous && previous.kind !== 'direct') {
    if (previous.value === entry.value) return { ...previous, observedAtMs: Math.max(previous.observedAtMs, stamp) };
    if (previous.observedAtMs - stamp > MODE_STAMP_SKEW_MS) return previous;
  }
  return { kind: entry.value === 'homey' ? 'controlled' : 'autonomous', value: entry.value, observedAtMs: stamp };
}

/** An older fetch cannot overwrite a later report; no local-write synthesis. */
function numericReport(
  entry: DeviceCapabilityMap[string] | undefined, previous: NumberReport | undefined, absolute: boolean,
): NumberReport | undefined {
  const stamp = toCapabilityTimestampMs(entry?.lastUpdated);
  if (!isFiniteNumber(entry?.value) || stamp === undefined) return previous;
  const value = absolute ? Math.abs(entry.value) : entry.value;
  if (value < 0) return previous;
  return previous !== undefined && previous.observedAtMs > stamp ? previous : { value, observedAtMs: stamp };
}

function readInverterReports(
  binding: InverterControlSurface | undefined, values: DeviceCapabilityMap, previous: InverterObservation | undefined,
): InverterObservation | undefined {
  const production = numericReport(values.measure_power, previous?.production, true);
  const limit = numericReport(values.target_power, previous?.limit, false);
  const mode = binding ? modeReport(binding, values.target_power_mode, previous?.mode) : previous?.mode;
  return production && limit && mode ? { production, limit, mode } : previous;
}

export function withInverterParseFields(
  snapshot: TransportDeviceSnapshot, device: HomeyDeviceLike, values: DeviceCapabilityMap,
  previous: TransportDeviceSnapshot | undefined,
): TransportDeviceSnapshot {
  if (!isSolarPanelDevice(device) || !device.capabilities?.includes('target_power')) return snapshot;
  const accepted = resolveInverterControl(device, values);
  const binding = accepted ?? previous?.inverterControl;
  // Metadata controls write authority; independently valid reports still confirm
  // a hand-back while that metadata is incomplete.
  const observation = readInverterReports(binding, values, previous?.inverterObservation);
  const control = accepted ?? (binding ? { ...binding, authority: 'release_only' as const } : undefined);
  return {
    ...snapshot,
    ...(control ? { inverterControl: control } : {}),
    ...(observation ? { inverterObservation: observation } : {}),
  };
}

/** Arrival-dated realtime reports, published by the caller as observation only. */
export function updateInverterObservation(
  snapshot: TransportDeviceSnapshot, capabilityId: string, value: unknown, nowMs: number,
): boolean {
  if (!snapshot.inverterControl || !snapshot.inverterObservation) return false;
  const previous = snapshot.inverterObservation;
  let next: InverterObservation;
  if (capabilityId === 'measure_power' && isFiniteNumber(value)) {
    next = { ...previous, production: { value: Math.abs(value), observedAtMs: nowMs } };
  } else if (capabilityId === 'target_power' && isFiniteNumber(value) && value >= 0) {
    next = { ...previous, limit: { value, observedAtMs: nowMs } };
  } else if (capabilityId === 'target_power_mode' && typeof value === 'string' && value.length > 0
    && snapshot.inverterControl.mode === 'switchable') {
    next = { ...previous, mode: { kind: value === 'homey' ? 'controlled' : 'autonomous', value, observedAtMs: nowMs } };
  } else return false;
  // Transport owns the mutable snapshot; the observer gets a copied value.
  const mutable = snapshot;
  /* eslint-disable-next-line functional/immutable-data */
  mutable.inverterObservation = next;
  return true;
}
