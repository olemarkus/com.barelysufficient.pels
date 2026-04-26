import type { FlowEffectiveRequiredCapabilityId } from './deviceManagerNativeEv';
import type { DeviceCapabilityMap } from './deviceManagerControl';
import {
  getCapabilityValueByPrefix,
} from './deviceManagerParse';
import type {
  FlowReportedCapabilityId,
  FlowReportedCapabilitiesForDevice,
} from './flowReportedCapabilities';

export function shouldSkipFlowBackedCandidate(params: {
  flowAugmentedDeviceType: 'binary' | 'evcharger' | 'unsupported';
  flowBackedCapabilityIds: FlowReportedCapabilityId[];
  capabilities: readonly string[];
  capabilityObj: DeviceCapabilityMap;
  requiredFlowCapabilityIds: readonly FlowEffectiveRequiredCapabilityId[];
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
  powerCapable: boolean;
}): boolean {
  const {
    flowAugmentedDeviceType,
    flowBackedCapabilityIds,
    capabilities,
    capabilityObj,
    requiredFlowCapabilityIds,
    reportedCapabilities,
    powerCapable,
  } = params;
  if (flowAugmentedDeviceType === 'unsupported') return false;

  const effectiveFlowCapabilityIds = flowBackedCapabilityIds.filter(
    (capabilityId) => capabilityId !== 'measure_battery',
  );
  const hasIncompleteFlowSupport = effectiveFlowCapabilityIds.length > 0
    && !hasAllRequiredFlowCapabilitiesInEffectiveView({
      capabilities,
      capabilityObj,
      requiredCapabilityIds: requiredFlowCapabilityIds,
      reportedCapabilities,
    });
  const isMissingDirectPowerSupport = effectiveFlowCapabilityIds.length === 0 && powerCapable === false;
  return hasIncompleteFlowSupport || isMissingDirectPowerSupport;
}

function hasAllRequiredFlowCapabilitiesInEffectiveView(params: {
  capabilities: readonly string[];
  capabilityObj: DeviceCapabilityMap;
  requiredCapabilityIds: readonly FlowEffectiveRequiredCapabilityId[];
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
}): boolean {
  const { capabilities, capabilityObj, requiredCapabilityIds, reportedCapabilities } = params;
  const capabilitySet = new Set(capabilities);
  return requiredCapabilityIds.every((capabilityId) => (
    hasRequiredFlowCapability({
      capabilityId,
      capabilities,
      capabilityObj,
      capabilitySet,
      reportedCapabilities,
    })
  ));
}

function hasRequiredFlowCapability(params: {
  capabilityId: FlowEffectiveRequiredCapabilityId;
  capabilities: readonly string[];
  capabilityObj: DeviceCapabilityMap;
  capabilitySet: Set<string>;
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
}): boolean {
  const {
    capabilityId,
    capabilities,
    capabilityObj,
    capabilitySet,
    reportedCapabilities,
  } = params;

  if (capabilityId === 'measure_power') {
    return getCapabilityValueByPrefix([...capabilities], capabilityObj, 'measure_power') !== undefined
      || getCapabilityValueByPrefix([...capabilities], capabilityObj, 'meter_power') !== undefined;
  }

  if (capabilityId === 'alarm_generic.car_connected' || capabilityId === 'pels_evcharger_resumable') {
    return typeof reportedCapabilities[capabilityId]?.value === 'boolean';
  }

  return capabilitySet.has(capabilityId) && capabilityObj[capabilityId] !== undefined;
}
