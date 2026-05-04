import { shouldEmitOnChange } from '../logging/logDedupe';
import type {
  DeviceControlAdapterSnapshot,
  HomeyDeviceLike,
  Logger,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../utils/types';
import {
  augmentCapabilitiesWithFlowReports,
  getFlowEffectiveRequiredCapabilitiesForType,
  resolveFlowAugmentedDeviceType,
  type FlowReportedCapabilitiesForDevice,
  type FlowReportedCapabilityId,
} from './flowReportedCapabilities';
import {
  applyNativeEvWiringOverlay,
  hasOfficialEvChargerCapabilities,
} from './nativeEvWiring';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from './deviceManagerControl';
import { resolveDeviceCapabilities } from './deviceManagerParse';
import type { DeviceManagerParseProviders } from './deviceManagerParseDevice';
import {
  buildNativeSteppedLoadControlAdapter,
  buildSyntheticTargetPowerCapabilityMap,
  hasTargetPowerCapability,
  isNativeSteppedLoadWiringCandidate,
  isTargetPowerSteppedLoadWiringCandidate,
  resolveNativeSteppedLoadObservationCapabilityId,
  resolveNativeSteppedLoadProfileSuggestion,
  resolveNativeSteppedLoadReportedStepId,
  resolveTargetPowerReportedStepId,
  resolveTargetPowerSteppedLoadProfileFromConfig,
  stripNativeSteppedLoadControlCapabilities,
} from './nativeSteppedLoadWiring';
import { resolveDeviceCompatibilityTargetPowerConfig } from './deviceCompatibility';

export type FlowEffectiveRequiredCapabilityId =
  'onoff'
  | 'measure_power'
  | 'evcharger_charging'
  | 'alarm_generic.car_connected'
  | 'pels_evcharger_resumable'
  | 'evcharger_charging_state';

const detectionLogState = new Map<string, { signature: string; emittedAt: number }>();
const DETECTION_LOG_REPEAT_AFTER_MS = 10 * 60 * 1000;

export function resolveFlowCapabilityOverlay(params: {
  device: HomeyDeviceLike;
  deviceClassKey: string;
  deviceId: string;
  rawCapabilities: string[];
  rawCapabilityObj: DeviceCapabilityMap;
  providers: DeviceManagerParseProviders;
  logger: Logger;
}): {
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  controlAdapter?: DeviceControlAdapterSnapshot;
  controlWriteCapabilityId?: string;
  controlObservationCapabilityId?: string;
  flowAugmentedDeviceType: ReturnType<typeof resolveFlowAugmentedDeviceType>;
  flowBackedCapabilityIds: FlowReportedCapabilityId[];
  requiredFlowCapabilityIds: readonly FlowEffectiveRequiredCapabilityId[];
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
  reportedStepId?: string;
  reportedStepObservedAtMs?: number;
  suggestedSteppedLoadProfile?: SteppedLoadProfile;
  controlModel?: 'stepped_load';
  steppedLoadProfile?: SteppedLoadProfile;
  targetPowerConfig?: TargetDeviceSnapshot['targetPowerConfig'];
  allReportedCapabilities: FlowReportedCapabilitiesForDevice;
} {
  const {
    device,
    deviceClassKey,
    deviceId,
    rawCapabilities,
    rawCapabilityObj,
    providers,
    logger,
  } = params;
  const nativeEvOverlay = applyNativeEvWiringOverlay({
    device,
    capabilities: rawCapabilities,
    capabilityObj: rawCapabilityObj,
    nativeWiringEnabled: providers.getNativeEvWiringEnabled?.(deviceId) === true,
  });
  logNativeEvCandidate({
    logger,
    device,
    controlAdapter: nativeEvOverlay.controlAdapter,
  });

  const overlayCapabilities = nativeEvOverlay.capabilities;
  const overlayCapabilityObj = nativeEvOverlay.capabilityObj;
  const targetPowerOverlay = applySyntheticTargetPowerOverlay({
    device,
    deviceId,
    capabilities: overlayCapabilities,
    capabilityObj: overlayCapabilityObj,
    evPresetOnly: isNativeEvControlAdapterActive(nativeEvOverlay),
    providers,
  });
  const nativeSteppedOverlay = resolveNativeSteppedLoadOverlay({
    device,
    deviceId,
    capabilities: targetPowerOverlay.capabilities,
    capabilityObj: targetPowerOverlay.capabilityObj,
    profileOverride: targetPowerOverlay.steppedLoadProfile,
    providers,
  });
  const targetCapabilityIds = targetPowerOverlay.capabilities.filter(
    (capabilityId) => capabilityId.startsWith('target_temperature'),
  );
  const flowAugmentedDeviceType = resolveFlowAugmentedDeviceType({
    deviceClassKey,
    targetCapabilityIds,
  });
  const requiredFlowCapabilityIds = getFlowEffectiveRequiredCapabilitiesForType(flowAugmentedDeviceType);
  const allReportedCapabilities = providers.getFlowReportedCapabilities?.(deviceId) ?? {};
  const reportedCapabilities = shouldIgnoreFlowReports({
    rawCapabilities,
    controlAdapter: nativeEvOverlay.controlAdapter,
    managed: providers.getManaged?.(deviceId) === true,
  })
    ? pickSupplementalFlowReports(allReportedCapabilities)
    : allReportedCapabilities;
  const {
    capabilities,
    capabilityObj,
    flowBackedCapabilityIds,
  } = augmentCapabilitiesWithFlowReports({
    deviceType: flowAugmentedDeviceType,
    capabilities: targetPowerOverlay.capabilities,
    capabilityObj: targetPowerOverlay.capabilityObj,
    reportedCapabilities,
  });
  const controlAdapter = resolveOverlayControlAdapter({
    nativeEvControlAdapter: nativeEvOverlay.controlAdapter,
    nativeSteppedControlAdapter: nativeSteppedOverlay.controlAdapter,
  });
  const activeNativeSteppedProfile = resolveActiveNativeSteppedProfile(nativeSteppedOverlay);
  const steppedLoadProfile = targetPowerOverlay.steppedLoadProfile ?? activeNativeSteppedProfile;

  return {
    capabilities: stripNativeSteppedLoadControlCapabilities({ device, capabilities, capabilityObj }),
    capabilityObj,
    controlAdapter,
    controlWriteCapabilityId: nativeEvOverlay.controlWriteCapabilityId,
    controlObservationCapabilityId: nativeEvOverlay.controlObservationCapabilityId,
    flowAugmentedDeviceType,
    flowBackedCapabilityIds,
    requiredFlowCapabilityIds,
    reportedCapabilities,
    reportedStepId: nativeSteppedOverlay.reportedStepId ?? targetPowerOverlay.reportedStepId,
    reportedStepObservedAtMs: nativeSteppedOverlay.reportedStepObservedAtMs
      ?? targetPowerOverlay.reportedStepObservedAtMs,
    suggestedSteppedLoadProfile: nativeSteppedOverlay.suggestedSteppedLoadProfile,
    controlModel: steppedLoadProfile ? 'stepped_load' : undefined,
    steppedLoadProfile,
    targetPowerConfig: targetPowerOverlay.targetPowerConfig,
    allReportedCapabilities,
  };
}

function shouldIgnoreFlowReports(params: {
  rawCapabilities: readonly string[];
  controlAdapter?: DeviceControlAdapterSnapshot;
  managed: boolean;
}): boolean {
  const { rawCapabilities, controlAdapter, managed } = params;
  return hasOfficialEvChargerCapabilities(rawCapabilities)
    || controlAdapter?.activationEnabled === true
    || (controlAdapter?.activationRequired === true && !managed);
}

function resolveOverlayControlAdapter(params: {
  nativeEvControlAdapter?: DeviceControlAdapterSnapshot;
  nativeSteppedControlAdapter?: DeviceControlAdapterSnapshot;
}): DeviceControlAdapterSnapshot | undefined {
  if (params.nativeEvControlAdapter?.activationEnabled === true) return params.nativeEvControlAdapter;
  const { nativeEvControlAdapter, nativeSteppedControlAdapter } = params;
  return nativeEvControlAdapter?.activationRequired === true
    && nativeEvControlAdapter.activationEnabled !== true
    ? nativeEvControlAdapter
    : (nativeSteppedControlAdapter ?? nativeEvControlAdapter);
}

function isNativeEvControlAdapterActive(params: {
  controlAdapter?: DeviceControlAdapterSnapshot;
  controlWriteCapabilityId?: string;
}): boolean {
  return params.controlAdapter?.kind === 'capability_adapter'
    && params.controlAdapter.activationEnabled === true
    && params.controlWriteCapabilityId === 'charging_button';
}

function resolveActiveNativeSteppedProfile(params: {
  controlAdapter?: DeviceControlAdapterSnapshot;
  suggestedSteppedLoadProfile?: SteppedLoadProfile;
}): SteppedLoadProfile | undefined {
  return params.controlAdapter?.activationEnabled === true
    ? params.suggestedSteppedLoadProfile
    : undefined;
}

function applySyntheticTargetPowerOverlay(params: {
  device: HomeyDeviceLike;
  deviceId: string;
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  evPresetOnly?: boolean;
  providers: DeviceManagerParseProviders;
}): {
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  steppedLoadProfile?: SteppedLoadProfile;
  reportedStepId?: string;
  reportedStepObservedAtMs?: number;
  targetPowerConfig?: TargetDeviceSnapshot['targetPowerConfig'];
} {
  const config = params.providers.getDeviceTargetPowerConfig?.(params.deviceId)
    ?? resolveDeviceCompatibilityTargetPowerConfig(params.device);
  if (params.evPresetOnly === true && !isEvTargetPowerPresetConfig(config)) {
    return {
      capabilities: params.capabilities,
      capabilityObj: params.capabilityObj,
    };
  }
  const steppedLoadProfile = resolveTargetPowerSteppedLoadProfileFromConfig(config);
  if (!config || !steppedLoadProfile) {
    return {
      capabilities: params.capabilities,
      capabilityObj: params.capabilityObj,
    };
  }
  const capabilities = hasTargetPowerCapability(params.capabilities)
    ? params.capabilities
    : [...params.capabilities, 'target_power'];
  const observedTargetPower = resolveAvailableInstallationTargetPowerObservation({
    config,
    capabilityObj: params.capabilityObj,
  });
  const capabilityObj = buildSyntheticTargetPowerCapabilityMap({
    capabilityObj: params.capabilityObj,
    config,
    observedValue: observedTargetPower?.value,
    observedAt: observedTargetPower?.observedAt,
  });
  return {
    capabilities,
    capabilityObj,
    steppedLoadProfile,
    reportedStepId: resolveTargetPowerReportedStepId({ profile: steppedLoadProfile, capabilityObj }),
    reportedStepObservedAtMs: toCapabilityTimestampMs(capabilityObj.target_power?.lastUpdated),
    targetPowerConfig: config,
  };
}

function isEvTargetPowerPresetConfig(
  config: TargetDeviceSnapshot['targetPowerConfig'] | undefined,
): boolean {
  return config?.preset === 'ev_charger_1_phase' || config?.preset === 'ev_charger_3_phase';
}

function resolveAvailableInstallationTargetPowerObservation(params: {
  config: TargetDeviceSnapshot['targetPowerConfig'];
  capabilityObj: DeviceCapabilityMap;
}): { value: number; observedAt?: DeviceCapabilityMap[string]['lastUpdated'] } | undefined {
  let phaseCount: number | undefined;
  if (params.config?.preset === 'ev_charger_1_phase') {
    phaseCount = 1;
  } else if (params.config?.preset === 'ev_charger_3_phase') {
    phaseCount = 3;
  }
  const availableCurrent = params.capabilityObj.available_installation_current?.value;
  if (!phaseCount || typeof availableCurrent !== 'number' || !Number.isFinite(availableCurrent)) return undefined;
  return {
    value: Math.round(availableCurrent * 230 * phaseCount),
    observedAt: params.capabilityObj.available_installation_current?.lastUpdated,
  };
}

function resolveNativeSteppedLoadOverlay(params: {
  device: HomeyDeviceLike;
  deviceId: string;
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  profileOverride?: SteppedLoadProfile;
  providers: DeviceManagerParseProviders;
}): {
  controlAdapter?: DeviceControlAdapterSnapshot;
  reportedStepId?: string;
  reportedStepObservedAtMs?: number;
  suggestedSteppedLoadProfile?: SteppedLoadProfile;
} {
  const {
    device,
    deviceId,
    capabilities,
    capabilityObj,
    profileOverride,
    providers,
  } = params;
  const targetPowerSteppedCandidate = isTargetPowerSteppedLoadWiringCandidate({ capabilities, capabilityObj });
  const nativeSteppedCandidate = isNativeSteppedLoadWiringCandidate({
    device,
    capabilities,
    capabilityObj,
  });
  const suggestedSteppedLoadProfile = profileOverride ?? resolveNativeSteppedLoadProfileSuggestion({
    device,
    capabilities,
    capabilityObj,
  });
  if (!nativeSteppedCandidate || !suggestedSteppedLoadProfile) return {};

  const nativeSteppedEnabled = targetPowerSteppedCandidate || providers.getNativeEvWiringEnabled?.(deviceId) === true;
  let reportedStepId: string | undefined;
  if (nativeSteppedEnabled) {
    reportedStepId = resolveNativeSteppedLoadReportedStepId({
      profile: suggestedSteppedLoadProfile,
      capabilities,
      capabilityObj,
    });
  }
  return {
    controlAdapter: buildNativeSteppedLoadControlAdapter({
      nativeWiringEnabled: nativeSteppedEnabled,
      activationAvailable: !targetPowerSteppedCandidate,
    }),
    reportedStepId,
    reportedStepObservedAtMs: reportedStepId
      ? resolveNativeSteppedLoadObservedAtMs({ device, capabilities, capabilityObj })
      : undefined,
    suggestedSteppedLoadProfile,
  };
}

function resolveNativeSteppedLoadObservedAtMs(params: {
  device: HomeyDeviceLike;
  capabilities: readonly string[];
  capabilityObj: DeviceCapabilityMap;
}): number | undefined {
  void params.device;
  const nativeCapabilityId = resolveNativeSteppedLoadObservationCapabilityId({
    capabilities: params.capabilities,
    capabilityObj: params.capabilityObj,
  });
  return toCapabilityTimestampMs(
    nativeCapabilityId ? params.capabilityObj[nativeCapabilityId]?.lastUpdated : undefined,
  );
}

function pickSupplementalFlowReports(
  reportedCapabilities: FlowReportedCapabilitiesForDevice,
): FlowReportedCapabilitiesForDevice {
  return reportedCapabilities.measure_battery
    ? { measure_battery: reportedCapabilities.measure_battery }
    : {};
}

export function resolveCandidateCapabilities(params: {
  deviceClassKey: string;
  deviceId: string;
  deviceLabel: string;
  capabilities: string[];
  controlAdapter?: DeviceControlAdapterSnapshot;
  steppedLoadProfile?: SteppedLoadProfile;
  logDebug: (...args: unknown[]) => void;
}): { targetCaps: string[]; hasPower: boolean } | null {
  const {
    deviceClassKey,
    deviceId,
    deviceLabel,
    capabilities,
    controlAdapter,
    steppedLoadProfile,
    logDebug,
  } = params;
  if (deviceClassKey === 'evcharger' && steppedLoadProfile?.model === 'stepped_load') {
    return {
      targetCaps: [],
      hasPower: hasAnyPowerCapability(capabilities),
    };
  }
  if (
    deviceClassKey === 'evcharger'
    && isCapabilityAdapterEvCandidate(controlAdapter)
    && !capabilities.includes('evcharger_charging')
  ) {
    return {
      targetCaps: [],
      hasPower: hasAnyPowerCapability(capabilities),
    };
  }
  return resolveDeviceCapabilities({
    deviceClassKey,
    deviceId,
    deviceLabel,
    capabilities,
    logDebug,
  });
}

function isCapabilityAdapterEvCandidate(
  controlAdapter?: DeviceControlAdapterSnapshot,
): boolean {
  return controlAdapter?.activationAvailable === true
    || (
      controlAdapter?.activationRequired === true
      && controlAdapter.activationEnabled !== true
    );
}

function hasAnyPowerCapability(capabilities: readonly string[]): boolean {
  return capabilities.some((capabilityId) => (
    capabilityId === 'measure_power'
    || capabilityId === 'meter_power'
  ));
}

function logNativeEvCandidate(params: {
  logger: Logger;
  device: HomeyDeviceLike;
  controlAdapter?: DeviceControlAdapterSnapshot;
}): void {
  const {
    logger,
    device,
    controlAdapter,
  } = params;
  if (controlAdapter?.activationRequired !== true) return;
  if (!shouldLogDetection({
    key: `${device.id}:candidate`,
    signature: JSON.stringify({
      driverId: device.driverId ?? null,
      ownerUri: device.ownerUri ?? null,
      activationEnabled: controlAdapter.activationEnabled,
    }),
  })) {
    return;
  }
  logger.structuredLog?.debug({
    event: 'native_ev_candidate_detected',
    deviceId: device.id,
    deviceName: device.name,
    driverId: device.driverId ?? null,
    ownerUri: device.ownerUri ?? null,
    activationEnabled: controlAdapter.activationEnabled,
  });
}

function shouldLogDetection(params: {
  key: string;
  signature: string;
}): boolean {
  const { key, signature } = params;
  return shouldEmitOnChange({
    state: detectionLogState,
    key,
    signature,
    now: Date.now(),
    repeatAfterMs: DETECTION_LOG_REPEAT_AFTER_MS,
  });
}
