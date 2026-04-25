import { shouldEmitOnChange } from '../logging/logDedupe';
import type { DeviceControlAdapterSnapshot, HomeyDeviceLike, Logger } from '../utils/types';
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
import type { DeviceCapabilityMap } from './deviceManagerControl';
import { resolveDeviceCapabilities } from './deviceManagerParse';
import type { DeviceManagerParseProviders } from './deviceManagerParseDevice';

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
  const targetCapabilityIds = overlayCapabilities.filter(
    (capabilityId) => capabilityId.startsWith('target_temperature'),
  );
  const flowAugmentedDeviceType = resolveFlowAugmentedDeviceType({
    deviceClassKey,
    targetCapabilityIds,
  });
  const requiredFlowCapabilityIds = getFlowEffectiveRequiredCapabilitiesForType(flowAugmentedDeviceType);
  const hasNativeEvCapabilities = hasOfficialEvChargerCapabilities(rawCapabilities);
  const shouldIgnoreFlowReports = hasNativeEvCapabilities
    || nativeEvOverlay.controlAdapter?.activationEnabled === true
    || (
    nativeEvOverlay.controlAdapter?.activationRequired === true
    && providers.getManaged?.(deviceId) !== true
  );
  const reportedCapabilities = shouldIgnoreFlowReports
    ? {}
    : (providers.getFlowReportedCapabilities?.(deviceId) ?? {});
  const {
    capabilities,
    capabilityObj,
    flowBackedCapabilityIds,
  } = augmentCapabilitiesWithFlowReports({
    deviceType: flowAugmentedDeviceType,
    capabilities: overlayCapabilities,
    capabilityObj: overlayCapabilityObj,
    reportedCapabilities,
  });

  return {
    capabilities,
    capabilityObj,
    controlAdapter: nativeEvOverlay.controlAdapter,
    controlWriteCapabilityId: nativeEvOverlay.controlWriteCapabilityId,
    controlObservationCapabilityId: nativeEvOverlay.controlObservationCapabilityId,
    flowAugmentedDeviceType,
    flowBackedCapabilityIds,
    requiredFlowCapabilityIds,
    reportedCapabilities,
  };
}

export function resolveCandidateCapabilities(params: {
  deviceClassKey: string;
  deviceId: string;
  deviceLabel: string;
  capabilities: string[];
  controlAdapter?: DeviceControlAdapterSnapshot;
  logDebug: (...args: unknown[]) => void;
}): { targetCaps: string[]; hasPower: boolean } | null {
  const {
    deviceClassKey,
    deviceId,
    deviceLabel,
    capabilities,
    controlAdapter,
    logDebug,
  } = params;
  if (
    deviceClassKey === 'evcharger'
    && controlAdapter?.activationRequired === true
    && controlAdapter.activationEnabled !== true
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

function hasAnyPowerCapability(capabilities: readonly string[]): boolean {
  return capabilities.some((capabilityId) => (
    capabilityId === 'measure_power'
    || capabilityId.startsWith('measure_power.')
    || capabilityId === 'meter_power'
    || capabilityId.startsWith('meter_power.')
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
