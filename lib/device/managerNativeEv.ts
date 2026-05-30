import type {
  DeviceControlAdapterSnapshot,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import {
  augmentCapabilitiesWithFlowReports,
  getFlowEffectiveRequiredCapabilitiesForType,
  resolveFlowAugmentedDeviceType,
  type FlowReportedCapabilitiesForDevice,
  type FlowReportedCapabilityId,
} from './transport/flowReportedCapabilities';
import {
  applyNativeEvWiringOverlay,
  hasOfficialEvChargerCapabilities,
} from './nativeEvWiring';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from './managerControl';
import { resolveDeviceCapabilities } from './transport/managerParse';
import type { DeviceTransportParseProviders } from './transport/managerParseDevice';
import {
  buildNativeSteppedLoadControlAdapter,
  buildSyntheticTargetPowerCapabilityMap,
  hasTargetPowerCapability,
  isNativeSteppedLoadWiringCandidate,
  isTargetPowerSteppedLoadWiringCandidate,
  resolveNativeSteppedLoadObservationCapabilityId,
  resolveNativeSteppedLoadProfileSuggestion,
  resolveNativeSteppedLoadReportedStepId,
  resolveNativeSteppedLoadWriteCapabilities,
  resolveTargetPowerReportedStepId,
  resolveTargetPowerSteppedLoadProfileFromConfig,
  stripNativeSteppedLoadControlCapabilities,
} from './nativeSteppedLoadWiring';
import {
  resetTargetPowerContractLogStateForTests,
  warnIfTargetPowerCapabilityViolatesContract,
} from './targetPowerContractWarn';
import { resolveDeviceCompatibilityTargetPowerConfig } from './compatibility';

export type FlowEffectiveRequiredCapabilityId =
  'onoff'
  | 'measure_power'
  | 'evcharger_charging'
  | 'alarm_generic.car_connected'
  | 'pels_evcharger_resumable'
  | 'evcharger_charging_state';

export function __resetNativeEvWiringLogStateForTests(): void {
  resetTargetPowerContractLogStateForTests();
}

export function resolveFlowCapabilityOverlay(params: {
  device: HomeyDeviceLike;
  deviceClassKey: string;
  deviceId: string;
  rawCapabilities: string[];
  rawCapabilityObj: DeviceCapabilityMap;
  providers: DeviceTransportParseProviders;
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
  nativeWriteCapabilities?: string[];
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
  const nativeEvOverlay = applyOverlaysWithDiagnostics({
    device,
    deviceId,
    rawCapabilities,
    rawCapabilityObj,
    providers,
    logger,
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
  const nativeWriteCapabilities = resolveCandidateNativeWriteCapabilities({
    device,
    rawCapabilities,
    rawCapabilityObj,
  });

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
    nativeWriteCapabilities,
    targetPowerConfig: targetPowerOverlay.targetPowerConfig,
    allReportedCapabilities,
  };
}

/**
 * Owned native-write capabilities for the flow-conflict signal
 * (notes/native-wiring/). Resolved from the RAW capabilities so:
 *   - the real native control caps (max_power_* / target_power) are present
 *     (the public snapshot list has them stripped), and
 *   - a SYNTHETIC target_power (injected for a saved target-power/EV preset on
 *     a device with no real setable target_power) is excluded — PELS does not
 *     natively write that capability there, so it must not be flagged as a
 *     conflict.
 * Gated on genuine native candidacy (`isNativeSteppedLoadWiringCandidate`),
 * which holds even when native wiring is OFF — so the not-yet-enabled devices
 * the conflict gate exists for are still covered. Returns undefined when not a
 * native candidate or no native-write capability is present.
 */
function resolveCandidateNativeWriteCapabilities(params: {
  device: HomeyDeviceLike;
  rawCapabilities: readonly string[];
  rawCapabilityObj: DeviceCapabilityMap;
}): string[] | undefined {
  const isCandidate = isNativeSteppedLoadWiringCandidate({
    device: params.device,
    capabilities: params.rawCapabilities,
    capabilityObj: params.rawCapabilityObj,
  });
  if (!isCandidate) return undefined;
  const owned = resolveNativeSteppedLoadWriteCapabilities(params.rawCapabilities);
  return owned.length > 0 ? owned : undefined;
}

function applyOverlaysWithDiagnostics(params: {
  device: HomeyDeviceLike;
  deviceId: string;
  rawCapabilities: string[];
  rawCapabilityObj: DeviceCapabilityMap;
  providers: DeviceTransportParseProviders;
  logger: Logger;
}): ReturnType<typeof applyNativeEvWiringOverlay> {
  const overlay = applyNativeEvWiringOverlay({
    device: params.device,
    capabilities: params.rawCapabilities,
    capabilityObj: params.rawCapabilityObj,
  });
  warnIfTargetPowerCapabilityViolatesContract({
    logger: params.logger,
    device: params.device,
    capabilities: overlay.capabilities,
    capabilityObj: overlay.capabilityObj,
  });
  return overlay;
}

function shouldIgnoreFlowReports(params: {
  rawCapabilities: readonly string[];
  controlAdapter?: DeviceControlAdapterSnapshot;
}): boolean {
  const { rawCapabilities, controlAdapter } = params;
  return hasOfficialEvChargerCapabilities(rawCapabilities)
    || controlAdapter?.activationEnabled === true;
}

function resolveOverlayControlAdapter(params: {
  nativeEvControlAdapter?: DeviceControlAdapterSnapshot;
  nativeSteppedControlAdapter?: DeviceControlAdapterSnapshot;
}): DeviceControlAdapterSnapshot | undefined {
  if (params.nativeEvControlAdapter?.activationEnabled === true) return params.nativeEvControlAdapter;
  return params.nativeSteppedControlAdapter ?? params.nativeEvControlAdapter;
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
  providers: DeviceTransportParseProviders;
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
  providers: DeviceTransportParseProviders;
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
  return controlAdapter?.activationAvailable === true;
}

function hasAnyPowerCapability(capabilities: readonly string[]): boolean {
  return capabilities.some((capabilityId) => (
    capabilityId === 'measure_power'
    || capabilityId === 'meter_power'
  ));
}

