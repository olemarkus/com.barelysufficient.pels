/* eslint-disable functional/immutable-data -- debug payload assembly is local and not shared mutable state. */
import type Homey from 'homey';
import type {
  DeviceCalibration,
  PowerCalibrationSnapshot,
} from '../packages/contracts/src/powerCalibration';
import type {
  DeviceDebugObservedSource,
  DeviceDebugObservedSources,
  DeviceTransport,
} from '../lib/device/deviceTransport';
import { formatDeviceReason } from '../packages/shared-domain/src/planReasonSemantics';
import { DEVICES_API_PATH, getRawDevices } from '../lib/device/transport/managerHomeyApi';
import type { DevicePlan, StepPowerCalibrationView } from '../lib/plan/planTypes';
import { isTemperaturePlanDevice } from '../lib/plan/planTemperatureDevice';
import type { HomeyDeviceLike } from '../lib/utils/types';
import { isHomeyDeviceLike } from '../lib/utils/types';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import { normalizeError } from '../lib/utils/errorUtils';
import { safeJsonStringify, sanitizeLogValue } from '../lib/utils/logUtils';
import { getLogger } from '../lib/logging/logger';

const debugLogger = getLogger('devices/debug-dump');

type UnknownRecord = Record<string, unknown>;

type EnergyApproximationValues = {
  usageOnW: number | null;
  usageOffW: number | null;
  energyW: number | null;
};

type EnergyInference = {
  inferredExpectedW: number | null;
  inferredSource: string | null;
};

type EnergyDebugPayload = EnergyApproximationValues & {
  onoff: boolean | null;
} & EnergyInference;

type DebugSection<T> = {
  available: boolean;
  payload: T | null;
  source?: string;
  error?: string;
};

type HomeyCapabilitySummary = {
  value?: unknown;
  units?: string;
  lastUpdated?: string;
  setable?: boolean;
  getable?: boolean;
};

type HomeyDeviceSummary = {
  id: string;
  name: string;
  class?: string;
  driverId?: string;
  available?: boolean;
  ready?: boolean;
  zone?: string;
  lastSeenAt?: string;
  capabilities: string[];
  capabilityValues: Record<string, HomeyCapabilitySummary>;
};

type PelsTargetSnapshotSummary = {
  id: string;
  name: string;
  deviceType?: string;
  controlModel?: TargetDeviceSnapshot['controlModel'];
  controlCapabilityId?: string;
  controlAdapter?: TargetDeviceSnapshot['controlAdapter'];
  capabilities?: string[];
  steppedLoadProfile?: TargetDeviceSnapshot['steppedLoadProfile'];
  suggestedSteppedLoadProfile?: TargetDeviceSnapshot['suggestedSteppedLoadProfile'];
  targetPowerConfig?: TargetDeviceSnapshot['targetPowerConfig'];
  binaryControl?: { on: boolean };
  currentTemperature?: number;
  targets: Array<{ id: string; value?: unknown; unit: string }>;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  reportedStepId?: string;
  controllable?: boolean;
  managed?: boolean;
  available?: boolean;
  lastUpdated?: number;
};

type PelsPlanDeviceSummary = {
  id: string;
  name: string;
  currentState: string;
  plannedState: string;
  currentTarget: unknown;
  plannedTarget?: number;
  reason?: string;
  controllable?: boolean;
  stepPowerCalibration?: Record<string, StepPowerCalibrationView>;
  pendingTargetCommand?: DevicePlan['devices'][number]['pendingTargetCommand'];
};

type PelsDeviceDebugState = {
  present: boolean;
  targetSnapshot: PelsTargetSnapshotSummary | null;
  planDevice: PelsPlanDeviceSummary | null;
  powerCalibration?: DeviceCalibration | null;
  observedSources?: PelsObservedSourcesSummary;
  error?: string;
};

type PelsObservedSourceSummary = {
  observedAt: string;
  path: string;
  state: DeviceStateComparisonSource | null;
  fetchSource?: string;
  capabilityId?: string;
  value?: unknown;
  localEcho?: boolean;
  shouldReconcilePlan?: boolean;
  preservedLocalState?: boolean;
  changes?: Array<{
    capabilityId: string;
    previousValue: string;
    nextValue: string;
  }>;
};

type PelsObservedSourcesSummary = {
  snapshotRefresh: PelsObservedSourceSummary | null;
  deviceUpdate: PelsObservedSourceSummary | null;
  realtimeCapabilities: Record<string, PelsObservedSourceSummary>;
  localWrites: Record<string, PelsObservedSourceSummary>;
};

type DeviceDebugDump = {
  homey: {
    summary: DebugSection<HomeyDeviceSummary>;
    settings: DebugSection<unknown>;
    energyApproximation: DebugSection<EnergyDebugPayload>;
    comparison: DebugSection<DeviceStateComparison>;
  };
  pels?: PelsDeviceDebugState;
};

type DeviceStateComparisonSource = {
  sourceState?: string;
  target?: unknown;
  powerW?: number | null;
  lastSeenAt?: string;
  onoffLastUpdated?: string;
  targetLastUpdated?: string;
  powerLastUpdated?: string;
};

type DeviceStateComparison = {
  managerDevices: DeviceStateComparisonSource | null;
  pelsSnapshot: DeviceStateComparisonSource | null;
  pelsPlan: {
    currentState: string;
    plannedState: string;
    currentTarget: unknown;
    plannedTarget?: number;
    pendingTargetCommand?: DevicePlan['devices'][number]['pendingTargetCommand'];
  } | null;
};

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null
);

const asFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

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

const buildEnergyDebugPayload = (device: HomeyDeviceLike): EnergyDebugPayload | null => {
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

const buildAvailableSection = <T>(payload: T): DebugSection<T> => ({
  available: true,
  payload,
});

const buildUnavailableSection = <T>(error?: string): DebugSection<T> => ({
  available: false,
  payload: null,
  ...(error ? { error } : {}),
});

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.length > 0 ? value : undefined
);

const asTimestampString = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
};

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

const getCapabilityEntry = (device: HomeyDeviceLike, capabilityId: string): UnknownRecord | null => {
  const entry = device.capabilitiesObj?.[capabilityId];
  return isRecord(entry) ? entry : null;
};

const asBinaryState = (value: unknown): string | undefined => {
  if (typeof value !== 'boolean') return undefined;
  return value ? 'on' : 'off';
};

/* eslint-disable complexity -- comparison serializer is a flat mapping of relevant state. */
const buildHomeyStateComparisonSource = (
  device: HomeyDeviceLike | null,
): DeviceStateComparisonSource | null => {
  if (!device) return null;
  const record = device as unknown as UnknownRecord;
  const onoff = getCapabilityEntry(device, 'onoff');
  const target = getCapabilityEntry(device, 'target_temperature');
  const power = getCapabilityEntry(device, 'measure_power');
  return {
    ...(asBinaryState(onoff?.value) ? { sourceState: asBinaryState(onoff?.value) } : {}),
    ...(Object.prototype.hasOwnProperty.call(target ?? {}, 'value') ? { target: target?.value } : {}),
    ...(typeof power?.value === 'number' && Number.isFinite(power.value) ? { powerW: power.value as number } : {}),
    ...(asTimestampString(record.lastSeenAt) ? { lastSeenAt: asTimestampString(record.lastSeenAt) } : {}),
    ...(asTimestampString(onoff?.lastUpdated) ? { onoffLastUpdated: asTimestampString(onoff?.lastUpdated) } : {}),
    ...(asTimestampString(target?.lastUpdated) ? { targetLastUpdated: asTimestampString(target?.lastUpdated) } : {}),
    ...(asTimestampString(power?.lastUpdated) ? { powerLastUpdated: asTimestampString(power?.lastUpdated) } : {}),
  };
};
/* eslint-enable complexity */

const buildPelsSnapshotComparisonSource = (
  snapshot: PelsTargetSnapshotSummary | TargetDeviceSnapshot | null,
): DeviceStateComparisonSource | null => {
  if (!snapshot) return null;
  const target = Array.isArray(snapshot.targets) ? snapshot.targets[0] : null;
  const powerW = resolveComparisonPowerW(snapshot);
  return {
    sourceState: (snapshot.binaryControl?.on ?? true) ? 'on' : 'off',
    ...(target ? { target: target.value } : {}),
    ...(powerW !== null ? { powerW } : {}),
    ...(asTimestampString(snapshot.lastUpdated) ? { lastSeenAt: asTimestampString(snapshot.lastUpdated) } : {}),
  };
};

const resolveComparisonPowerW = (
  snapshot: PelsTargetSnapshotSummary | TargetDeviceSnapshot,
): number | null => {
  if (typeof snapshot.measuredPowerKw === 'number') {
    return Math.round(snapshot.measuredPowerKw * 1000);
  }
  if (typeof snapshot.powerKw === 'number') {
    return Math.round(snapshot.powerKw * 1000);
  }
  return null;
};

const buildPelsPlanComparisonSource = (
  device: PelsPlanDeviceSummary | null,
): DeviceStateComparison['pelsPlan'] => {
  if (!device) return null;
  return {
    currentState: device.currentState,
    plannedState: device.plannedState,
    currentTarget: device.currentTarget,
    plannedTarget: device.plannedTarget,
    ...(device.pendingTargetCommand ? { pendingTargetCommand: device.pendingTargetCommand } : {}),
  };
};

const buildObservedSourceSummary = (
  source: DeviceDebugObservedSource,
): PelsObservedSourceSummary => {
  return {
    observedAt: new Date(source.observedAt).toISOString(),
    path: source.path,
    state: buildPelsSnapshotComparisonSource(source.snapshot),
    ...(source.fetchSource ? { fetchSource: source.fetchSource } : {}),
    ...(source.capabilityId ? { capabilityId: source.capabilityId } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, 'value') ? { value: source.value } : {}),
    ...(typeof source.localEcho === 'boolean' ? { localEcho: source.localEcho } : {}),
    ...(typeof source.shouldReconcilePlan === 'boolean' ? { shouldReconcilePlan: source.shouldReconcilePlan } : {}),
    ...(typeof source.preservedLocalState === 'boolean'
      ? { preservedLocalState: source.preservedLocalState }
      : {}),
    ...(source.changes ? { changes: source.changes.map((change) => ({ ...change })) } : {}),
  };
};

const buildOptionalObservedSourceSummary = (
  source: DeviceDebugObservedSource | undefined,
): PelsObservedSourceSummary | null => (
  source ? buildObservedSourceSummary(source) : null
);

const buildObservedSourcesSummary = (
  sources: DeviceDebugObservedSources | null | undefined,
): PelsObservedSourcesSummary | undefined => {
  if (!sources) return undefined;
  return {
    snapshotRefresh: buildOptionalObservedSourceSummary(sources.snapshotRefresh),
    deviceUpdate: buildOptionalObservedSourceSummary(sources.deviceUpdate),
    realtimeCapabilities: Object.fromEntries(
      Object.entries(sources.realtimeCapabilities).map(([capabilityId, source]) => [
        capabilityId,
        buildObservedSourceSummary(source),
      ]),
    ),
    localWrites: Object.fromEntries(
      Object.entries(sources.localWrites).map(([capabilityId, source]) => [
        capabilityId,
        buildObservedSourceSummary(source),
      ]),
    ),
  };
};

const compactHomeyDevice = (device: HomeyDeviceLike): HomeyDeviceSummary => {
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

const filterRelevantSettings = (settings: unknown): Record<string, unknown> | null => {
  if (!isRecord(settings)) return null;
  const filtered = Object.fromEntries(
    Object.entries(settings).filter(([key]) => !key.startsWith('zb_')),
  );
  return Object.keys(filtered).length > 0 ? filtered : null;
};

const compactPelsTargetSnapshot = (
  snapshot: TargetDeviceSnapshot | null,
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

const compactPelsPlanDevice = (
  device: DevicePlan['devices'][number] | null,
): PelsPlanDeviceSummary | null => {
  if (!device) return null;
  return {
    id: device.id,
    name: device.name,
    currentState: device.currentState,
    plannedState: device.plannedState,
    currentTarget: isTemperaturePlanDevice(device) ? device.currentTarget : null,
    plannedTarget: device.plannedTarget,
    reason: formatDeviceReason(device.reason),
    controllable: device.controllable,
    stepPowerCalibration: device.stepPowerCalibration,
    pendingTargetCommand: device.pendingTargetCommand,
  };
};

const getPelsPowerCalibration = (
  snapshot: PowerCalibrationSnapshot | null | undefined,
  deviceId: string,
): DeviceCalibration | null => snapshot?.devices[deviceId] ?? null;

const getRawManagerDeviceEntry = async (params: {
  deviceId: string;
}): Promise<HomeyDeviceLike | null> => {
  const { deviceId } = params;
  try {
    const devices = await getRawDevices(DEVICES_API_PATH);
    const list = Array.isArray(devices) ? devices : Object.values(devices || {});
    for (const entry of list) {
      if (isHomeyDeviceLike(entry) && entry.id === deviceId) {
        return entry;
      }
    }
    return null;
  } catch {
    return null;
  }
};

export async function getHomeyDevicesForDebug(params: {
  deviceManager: DeviceTransport;
}): Promise<HomeyDeviceLike[]> {
  const { deviceManager } = params;
  if (!deviceManager) return [];
  return deviceManager.getDevicesForDebug();
}

export async function getHomeyDevicesForDebugFromApp(app: Homey.App): Promise<HomeyDeviceLike[]> {
  const runtimeApp = app as Homey.App & { deviceManager?: DeviceTransport };
  if (!runtimeApp.deviceManager) return [];
  return getHomeyDevicesForDebug({ deviceManager: runtimeApp.deviceManager }).catch((err) => {
    runtimeApp.error?.('Failed to get Homey devices for debug', normalizeError(err));
    return [];
  });
}

export async function logHomeyDeviceForDebug(params: {
  deviceId: string;
  deviceManager: DeviceTransport;
  getPelsDeviceState?: (deviceId: string) => PelsDeviceDebugState | null;
  error: (msg: string, err: Error) => void;
}): Promise<boolean> {
  const {
    deviceId,
    deviceManager,
    getPelsDeviceState,
    error,
  } = params;
  if (!deviceId) return false;

  let devices: HomeyDeviceLike[];
  try {
    devices = await getHomeyDevicesForDebug({ deviceManager });
  } catch (err) {
    error('Failed to fetch Homey devices for debug', normalizeError(err));
    return false;
  }

  const device = devices.find((entry) => entry.id === deviceId);
  const safeDeviceId = sanitizeLogValue(deviceId);
  if (!device) {
    debugLogger.info({ event: 'homey_device_dump_device_not_found', deviceId: safeDeviceId });
    return false;
  }

  const label = device.name;
  const safeLabel = sanitizeLogValue(label) || safeDeviceId;
  const listSummary = compactHomeyDevice(device);
  const listSettings = filterRelevantSettings(device.settings);
  const dump: DeviceDebugDump = {
    homey: {
      summary: {
        ...buildAvailableSection(listSummary),
        source: 'listEntry',
      },
      settings: listSettings
        ? {
          ...buildAvailableSection(listSettings),
          source: 'listEntry',
        }
        : buildUnavailableSection(),
      energyApproximation: buildUnavailableSection(),
      comparison: buildUnavailableSection(),
    },
  };

  try {
    const energyApproximation = buildEnergyDebugPayload(device);
    dump.homey.energyApproximation = energyApproximation
      ? buildAvailableSection(energyApproximation)
      : buildUnavailableSection();
  } catch (err) {
    dump.homey.energyApproximation = buildUnavailableSection(normalizeError(err).message);
  }

  const rawManagerEntry = await getRawManagerDeviceEntry({ deviceId });

  if (typeof getPelsDeviceState === 'function') {
    try {
      dump.pels = getPelsDeviceState(deviceId) ?? {
        present: false,
        targetSnapshot: null,
        planDevice: null,
      };
    } catch (err) {
      dump.pels = {
        present: false,
        targetSnapshot: null,
        planDevice: null,
        error: normalizeError(err).message,
      };
    }
  }

  const comparisonPayload: DeviceStateComparison = {
    managerDevices: buildHomeyStateComparisonSource(rawManagerEntry),
    pelsSnapshot: buildPelsSnapshotComparisonSource(dump.pels?.targetSnapshot ?? null),
    pelsPlan: buildPelsPlanComparisonSource(dump.pels?.planDevice ?? null),
  };
  dump.homey.comparison = {
    ...buildAvailableSection(comparisonPayload),
    source: 'side_by_side',
  };

  debugLogger.info({
    event: 'homey_device_dump',
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: safeJsonStringify(dump),
  });
  return true;
}

// Comparison logging intentionally fans in multiple Homey and PELS state channels.
// eslint-disable-next-line complexity
export async function logHomeyDeviceComparisonForDebug(params: {
  deviceId: string;
  reason: string;
  expectedTarget?: number;
  observedTarget?: unknown;
  observedSource?: string;
  deviceManager: DeviceTransport;
  getPelsDeviceState?: (deviceId: string) => PelsDeviceDebugState | null;
  error: (msg: string, err: Error) => void;
}): Promise<boolean> {
  const {
    deviceId,
    reason,
    expectedTarget,
    observedTarget,
    observedSource,
    deviceManager,
    getPelsDeviceState,
    error,
  } = params;
  if (!deviceId) return false;

  let devices: HomeyDeviceLike[];
  try {
    devices = await getHomeyDevicesForDebug({ deviceManager });
  } catch (err) {
    error('Failed to fetch Homey devices for comparison debug', normalizeError(err));
    return false;
  }

  const device = devices.find((entry) => entry.id === deviceId);
  const safeDeviceId = sanitizeLogValue(deviceId);
  if (!device) {
    debugLogger.info({
      event: 'homey_pels_device_state_comparison_device_not_found',
      deviceId: safeDeviceId,
      reason,
    });
    return false;
  }

  const label = device.name;
  const safeLabel = sanitizeLogValue(label) || safeDeviceId;
  const rawManagerEntry = await getRawManagerDeviceEntry({ deviceId });
  const pelsState = typeof getPelsDeviceState === 'function'
    ? getPelsDeviceState(deviceId)
    : null;

  const comparisonPayload: DeviceStateComparison = {
    managerDevices: buildHomeyStateComparisonSource(rawManagerEntry),
    pelsSnapshot: buildPelsSnapshotComparisonSource(pelsState?.targetSnapshot ?? null),
    pelsPlan: buildPelsPlanComparisonSource(pelsState?.planDevice ?? null),
  };
  const observedSources = pelsState?.observedSources
    ?? buildObservedSourcesSummary(deviceManager.getDebugObservedSources?.(deviceId));

  debugLogger.info({
    event: 'homey_pels_device_state_comparison',
    deviceId: safeDeviceId,
    label: safeLabel,
    payload: safeJsonStringify({
      reason,
      ...(typeof expectedTarget === 'number' ? { expectedTarget } : {}),
      ...(observedTarget !== undefined ? { observedTarget } : {}),
      ...(observedSource ? { observedSource } : {}),
      ...(observedSources ? { observedSources } : {}),
      comparison: comparisonPayload,
    }),
  });
  return true;
}

export async function logHomeyDeviceForDebugFromApp(params: {
  app: Homey.App;
  deviceId: string;
}): Promise<boolean> {
  const { app, deviceId } = params;
  const runtimeApp = app as Homey.App & {
    deviceManager?: DeviceTransport;
    planService?: { getLatestPlanSnapshot?: () => DevicePlan | null };
    powerCalibrationStore?: { getSnapshot?: () => PowerCalibrationSnapshot };
  };
  if (!runtimeApp.deviceManager) return false;
  return logHomeyDeviceForDebug({
    deviceId,
    deviceManager: runtimeApp.deviceManager,
    getPelsDeviceState: (targetDeviceId) => {
      const targetSnapshot = compactPelsTargetSnapshot(
        runtimeApp.deviceManager?.getSnapshot?.()
          ?.find((entry) => entry.id === targetDeviceId) ?? null,
      );
      const planDevice = compactPelsPlanDevice(
        runtimeApp.planService?.getLatestPlanSnapshot?.()
          ?.devices.find((entry) => entry.id === targetDeviceId) ?? null,
      );
      const powerCalibration = getPelsPowerCalibration(
        runtimeApp.powerCalibrationStore?.getSnapshot?.(),
        targetDeviceId,
      );
      return {
        present: Boolean(targetSnapshot || planDevice || powerCalibration),
        targetSnapshot,
        planDevice,
        powerCalibration,
        observedSources: buildObservedSourcesSummary(
          runtimeApp.deviceManager?.getDebugObservedSources?.(targetDeviceId),
        ),
      };
    },
    error: (msg, err) => runtimeApp.error?.(msg, err),
  });
}

export async function logHomeyDeviceComparisonForDebugFromApp(params: {
  app: Homey.App;
  deviceId: string;
  reason: string;
  expectedTarget?: number;
  observedTarget?: unknown;
  observedSource?: string;
}): Promise<boolean> {
  const {
    app,
    deviceId,
    reason,
    expectedTarget,
    observedTarget,
    observedSource,
  } = params;
  const runtimeApp = app as Homey.App & {
    deviceManager?: DeviceTransport;
    planService?: { getLatestPlanSnapshot?: () => DevicePlan | null };
    powerCalibrationStore?: { getSnapshot?: () => PowerCalibrationSnapshot };
  };
  if (!runtimeApp.deviceManager) return false;
  return logHomeyDeviceComparisonForDebug({
    deviceId,
    reason,
    expectedTarget,
    observedTarget,
    observedSource,
    deviceManager: runtimeApp.deviceManager,
    getPelsDeviceState: (targetDeviceId) => {
      const targetSnapshot = compactPelsTargetSnapshot(
        runtimeApp.deviceManager?.getSnapshot?.()
          ?.find((entry) => entry.id === targetDeviceId) ?? null,
      );
      const planDevice = compactPelsPlanDevice(
        runtimeApp.planService?.getLatestPlanSnapshot?.()
          ?.devices.find((entry) => entry.id === targetDeviceId) ?? null,
      );
      const powerCalibration = getPelsPowerCalibration(
        runtimeApp.powerCalibrationStore?.getSnapshot?.(),
        targetDeviceId,
      );
      return {
        present: Boolean(targetSnapshot || planDevice || powerCalibration),
        targetSnapshot,
        planDevice,
        powerCalibration,
        observedSources: buildObservedSourcesSummary(
          runtimeApp.deviceManager?.getDebugObservedSources?.(targetDeviceId),
        ),
      };
    },
    error: (msg, err) => runtimeApp.error?.(msg, err),
  });
}
