import type {
  AcknowledgedStepObservation,
  AutomaticPowerControl,
  ReportedStepObservedProbe,
  DeviceControlAdapterSnapshot,
  SteppedLoadProfile,
  TargetPowerSteppedLoadConfig,
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
import type { DeviceParseSources } from './transport/managerParseDevice';
import type { ParsedDeviceIdentity } from './transport/managerParseIdentity';
import {
  AVAILABLE_INSTALLATION_CURRENT_CAPABILITY_ID,
  buildNativeSteppedLoadControlAdapter,
  buildSyntheticTargetPowerCapabilityMap,
  hasTargetPowerCapability,
  resolveAutomaticSteppedLoadProfile,
  hasNativeTargetPowerLadder,
  isNativeSteppedLoadWiringCandidate,
  isTargetPowerSteppedLoadCandidate,
  isTargetPowerControlActive,
  resolveTargetPowerModeInvalidationAtMs,
  resolveNativeSteppedLoadObservationCapabilityId,
  resolveNativeSteppedLoadProfileSuggestion,
  resolveNativeSteppedLoadReportedStepId,
  resolveNativeSteppedLoadWriteCapabilities,
  resolveTargetPowerReportedStepId,
  resolveTargetPowerSteppedControl,
  stripNativeSteppedLoadControlCapabilities,
} from './nativeSteppedLoadWiring';
import { getDeviceAdapter } from './deviceAdapterRegistry';
import { ACKNOWLEDGED_CURRENT_CAPABILITY_ID } from './deviceAdapter';
import { resolveAcknowledgedStepObservation } from './acknowledgedStep';
import { warnIfTargetPowerCapabilityViolatesContract } from './targetPowerContractWarn';
import { resolveDeviceCompatibilityTargetPowerConfig } from './compatibility';
import { withoutTargetPowerReachability } from './targetPowerReachability';
import { hasUsableSteppedLoadLadder } from '../../packages/shared-domain/src/deviceControlProfiles';
import { resolveTargetPowerPresetPhaseCount } from '../../packages/shared-domain/src/targetPowerStepping';
import { isBatteryOrSolarClassKey } from '../../packages/shared-domain/src/batteryOrSolarRole';

export type FlowEffectiveRequiredCapabilityId =
  'onoff'
  | 'measure_power'
  | 'evcharger_charging'
  | 'alarm_generic.car_connected'
  | 'pels_evcharger_resumable'
  | 'evcharger_charging_state';

export function resolveFlowCapabilityOverlay(
  identity: Pick<ParsedDeviceIdentity, 'effectiveDevice' | 'deviceClassKey' | 'deviceId'>,
  rawCapabilities: string[],
  rawCapabilityObj: DeviceCapabilityMap,
  sources: DeviceParseSources,
  logger: Logger,
): {
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  controlAdapter?: DeviceControlAdapterSnapshot;
  binaryWriteCapabilityId?: string;
  binaryObservationCapabilityId?: string;
  flowAugmentedDeviceType: ReturnType<typeof resolveFlowAugmentedDeviceType>;
  flowBackedCapabilityIds: FlowReportedCapabilityId[];
  requiredFlowCapabilityIds: readonly FlowEffectiveRequiredCapabilityId[];
  reportedCapabilities: FlowReportedCapabilitiesForDevice;
  reportedStepId?: string;
  reportedStepPowerW?: number;
  reportedStepObservedAtMs?: number;
  acknowledgedStep?: AcknowledgedStepObservation;
  suggestedSteppedLoadProfile?: SteppedLoadProfile;
  controlModel?: 'stepped_load';
  steppedLoadProfile?: SteppedLoadProfile;
  nativeWriteCapabilities?: string[];
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
  automaticPowerControl?: AutomaticPowerControl;
  allReportedCapabilities: FlowReportedCapabilitiesForDevice;
} {
  const { effectiveDevice: device, deviceClassKey, deviceId } = identity;
  const nativeEvOverlay = applyNativeEvWiringOverlay(device, rawCapabilities, rawCapabilityObj);
  // A battery or panel is never a stepped load: a home battery's `target_power`
  // is signed (negative discharges), so a 0..max ladder would misread it, and
  // `batteryControlWiring.ts` classifies it instead. Gated once here, where the
  // class key is known: no ladder-contract warning, no owner-configured or
  // native ladder (so no control adapter, which is what every later stepped
  // write and realtime path keys on), and its `target_power` is not stripped.
  const steppedLoad = !isBatteryOrSolarClassKey(deviceClassKey);
  const { targetPowerOverlay, nativeSteppedOverlay, automaticPowerControl }: SteppedLoadOverlays = steppedLoad
    ? applySteppedLoadOverlays(device, deviceId, nativeEvOverlay, sources, logger)
    : { targetPowerOverlay: nativeEvOverlay, nativeSteppedOverlay: {} };
  const targetCapabilityIds = targetPowerOverlay.capabilities
    .filter((capabilityId) => capabilityId === 'target_temperature');
  const flowAugmentedDeviceType = resolveFlowAugmentedDeviceType({
    deviceClassKey,
    targetCapabilityIds,
  });
  const requiredFlowCapabilityIds = getFlowEffectiveRequiredCapabilitiesForType(flowAugmentedDeviceType);
  const allReportedCapabilities = sources.flowBacked.getFlowReportedCapabilitiesForDevice(deviceId);
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
  } = augmentCapabilitiesWithFlowReports(
    flowAugmentedDeviceType,
    targetPowerOverlay.capabilities,
    targetPowerOverlay.capabilityObj,
    reportedCapabilities,
  );
  const controlAdapter = resolveOverlayControlAdapter(nativeEvOverlay, nativeSteppedOverlay.controlAdapter);
  const activeNativeSteppedProfile = resolveActiveNativeSteppedProfile(nativeSteppedOverlay);
  const savedFlowProfile = sources.settings.getDeviceControlProfile(deviceId);
  const steppedLoadProfile = activeNativeSteppedProfile
    ?? targetPowerOverlay.steppedLoadProfile
    ?? (hasUsableSteppedLoadLadder(savedFlowProfile) ? savedFlowProfile : undefined);
  const nativeWriteCapabilities = nativeSteppedOverlay.controlAdapter
    ? resolveCandidateNativeWriteCapabilities(device, rawCapabilities, rawCapabilityObj)
    : undefined;
  const finalCapabilities = steppedLoad
    ? stripNativeSteppedLoadControlCapabilities({ device, capabilities, capabilityObj })
    : capabilities;
  const finalCapabilityObj = controlAdapter
    ? getDeviceAdapter(device).finalizeObservation(controlAdapter, finalCapabilities, capabilityObj)
    : capabilityObj;
  return {
    capabilities: finalCapabilities,
    capabilityObj: finalCapabilityObj,
    controlAdapter,
    binaryWriteCapabilityId: nativeEvOverlay.binaryWriteCapabilityId,
    binaryObservationCapabilityId: nativeEvOverlay.binaryObservationCapabilityId,
    flowAugmentedDeviceType,
    flowBackedCapabilityIds,
    requiredFlowCapabilityIds,
    reportedCapabilities,
    reportedStepId: nativeSteppedOverlay.reportedStepId ?? targetPowerOverlay.reportedStepId,
    reportedStepPowerW: targetPowerOverlay.reportedStepPowerW,
    reportedStepObservedAtMs: targetPowerOverlay.reportedStepPowerW !== undefined
      ? targetPowerOverlay.reportedStepObservedAtMs : nativeSteppedOverlay.reportedStepObservedAtMs,
    acknowledgedStep: targetPowerOverlay.acknowledgedStep,
    suggestedSteppedLoadProfile: nativeSteppedOverlay.suggestedSteppedLoadProfile,
    controlModel: steppedLoadProfile ? 'stepped_load' : undefined,
    steppedLoadProfile,
    nativeWriteCapabilities,
    targetPowerConfig: targetPowerOverlay.targetPowerConfig,
    automaticPowerControl,
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
function resolveCandidateNativeWriteCapabilities(
  device: HomeyDeviceLike,
  rawCapabilities: readonly string[],
  rawCapabilityObj: DeviceCapabilityMap,
): string[] | undefined {
  const isCandidate = isNativeSteppedLoadWiringCandidate({
    device,
    capabilities: rawCapabilities,
    capabilityObj: rawCapabilityObj,
  });
  if (!isCandidate) return undefined;
  const owned = resolveNativeSteppedLoadWriteCapabilities(rawCapabilities);
  return owned.length > 0 ? owned : undefined;
}

type SteppedLoadOverlays = {
  targetPowerOverlay: ReturnType<typeof applySyntheticTargetPowerOverlay>;
  nativeSteppedOverlay: ReturnType<typeof resolveNativeSteppedLoadOverlay>;
  automaticPowerControl?: AutomaticPowerControl;
};

/**
 * The stepped-load overlays on top of the native EV overlay: the ladder-contract
 * warning, the owner-configured target-power ladder, then the native one.
 */
function applySteppedLoadOverlays(
  device: HomeyDeviceLike,
  deviceId: string,
  nativeEvOverlay: ReturnType<typeof applyNativeEvWiringOverlay>,
  sources: DeviceParseSources,
  logger: Logger,
): SteppedLoadOverlays {
  warnIfTargetPowerCapabilityViolatesContract({
    logger,
    device,
    capabilities: nativeEvOverlay.capabilities,
    capabilityObj: nativeEvOverlay.capabilityObj,
  });
  const nativeProfile = resolveAutomaticSteppedLoadProfile(
    device, nativeEvOverlay.capabilities, nativeEvOverlay.capabilityObj,
  );
  const automaticPowerControl: AutomaticPowerControl | undefined = nativeProfile ? {
    mode: sources.settings.resolveDevicePowerControlMode(
      deviceId, sources.chargingCurrent.requiresManualControl(deviceId),
    ),
    profile: nativeProfile,
  } : undefined;
  const targetPowerOverlay = applySyntheticTargetPowerOverlay(
    device,
    deviceId,
    nativeEvOverlay,
    isNativeEvControlAdapterActive(nativeEvOverlay),
    sources,
    automaticPowerControl,
  );
  const manualNativeWatts = usesManualCurrentControl(device, automaticPowerControl)
    && hasNativeTargetPowerLadder(nativeEvOverlay.capabilities, nativeEvOverlay.capabilityObj);
  const nativeSteppedOverlay = manualNativeWatts ? {}
    : resolveNativeSteppedLoadOverlay(device, deviceId, targetPowerOverlay, sources, automaticPowerControl);
  return { targetPowerOverlay, nativeSteppedOverlay, automaticPowerControl };
}

function shouldIgnoreFlowReports(params: {
  rawCapabilities: readonly string[];
  controlAdapter?: DeviceControlAdapterSnapshot;
}): boolean {
  const { rawCapabilities, controlAdapter } = params;
  return hasOfficialEvChargerCapabilities(rawCapabilities)
    || controlAdapter?.activationEnabled === true;
}

function resolveOverlayControlAdapter(
  nativeEvOverlay: ReturnType<typeof applyNativeEvWiringOverlay>,
  nativeSteppedControlAdapter: DeviceControlAdapterSnapshot | undefined,
): DeviceControlAdapterSnapshot | undefined {
  // An EV overlay without its binary facet cannot replace an independent native
  // stepped channel merely because the integration still supplies telemetry.
  if (nativeEvOverlay.capabilities.includes('evcharger_charging')
      && nativeEvOverlay.controlAdapter?.activationEnabled === true) return nativeEvOverlay.controlAdapter;
  return nativeSteppedControlAdapter ?? nativeEvOverlay.controlAdapter;
}

function isNativeEvControlAdapterActive(params: {
  controlAdapter?: DeviceControlAdapterSnapshot;
  binaryWriteCapabilityId?: string;
}): boolean {
  return params.controlAdapter?.kind === 'capability_adapter'
    && params.controlAdapter.activationEnabled === true
    && params.binaryWriteCapabilityId !== undefined;
}

function resolveActiveNativeSteppedProfile(params: {
  controlAdapter?: DeviceControlAdapterSnapshot;
  suggestedSteppedLoadProfile?: SteppedLoadProfile;
}): SteppedLoadProfile | undefined {
  return params.controlAdapter?.activationEnabled === true
    ? params.suggestedSteppedLoadProfile
    : undefined;
}

/**
 * The capability carrying the charger current an EV preset ladder is read back
 * from. `available_installation_current` (Zaptec) is a read-only report, read
 * whenever PELS does not write the charger's own watt target. An Easee's
 * `target_charger_current` is only read while PELS controls it natively: with
 * built-in control off, the owner's Flow writes that capability and reports it
 * through `Report stepped load`, and reading it here as well would put a second
 * reporter on the same step.
 */
function resolveInstallationCurrentCapabilityId(
  device: HomeyDeviceLike,
  deviceId: string,
  capabilityObj: DeviceCapabilityMap,
  sources: DeviceParseSources,
): string {
  const current = getDeviceAdapter(device).nativeCurrentControls
    .find((control) => control.accepts(device, capabilityObj));
  return current && sources.nativeWiring.resolveNativeWiringEnabled(deviceId)
    ? current.capabilityId : AVAILABLE_INSTALLATION_CURRENT_CAPABILITY_ID;
}

function applySyntheticTargetPowerOverlay(
  device: HomeyDeviceLike,
  deviceId: string,
  nativeEvOverlay: Pick<ReturnType<typeof applyNativeEvWiringOverlay>, 'capabilities' | 'capabilityObj'>,
  evPresetOnly: boolean,
  sources: DeviceParseSources,
  automaticPowerControl: AutomaticPowerControl | undefined,
): {
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  steppedLoadProfile?: SteppedLoadProfile;
  reportedStepId?: string;
  reportedStepPowerW?: number;
  reportedStepObservedAtMs?: number;
  acknowledgedStep?: AcknowledgedStepObservation;
  targetPowerConfig?: TargetPowerSteppedLoadConfig;
} {
  if (automaticPowerControl?.mode === 'automatic') {
    return { ...nativeEvOverlay, steppedLoadProfile: automaticPowerControl.profile };
  }
  const manualControl = usesManualCurrentControl(device, automaticPowerControl);
  const savedConfig = sources.settings.getDeviceTargetPowerConfig(deviceId)
    ?? resolveDeviceCompatibilityTargetPowerConfig(device);
  const config = savedConfig && getDeviceAdapter(device).configureTargetPower(device, savedConfig);
  if (!config || (evPresetOnly && !isEvTargetPowerPresetConfig(config))) {
    return {
      capabilities: nativeEvOverlay.capabilities,
      capabilityObj: nativeEvOverlay.capabilityObj,
    };
  }
  const capabilities = hasTargetPowerCapability(nativeEvOverlay.capabilities)
    ? nativeEvOverlay.capabilities
    : [...nativeEvOverlay.capabilities, 'target_power'];
  // On the native watt path PELS writes the device's own watt target, which
  // its driver turns into a current its own way (a Zaptec on an IT grid, or one
  // switching phases), so that target is the step it holds; the current times
  // the preset's phases would read another rung.
  const installationCurrent = !manualControl && isTargetPowerSteppedLoadCandidate(nativeEvOverlay)
    ? undefined
    : nativeEvOverlay.capabilityObj[resolveInstallationCurrentCapabilityId(
      device,
      deviceId,
      nativeEvOverlay.capabilityObj,
      sources,
    )];
  const observedTargetPower = installationCurrent
    && resolveInstallationCurrentTargetPowerObservation(config, installationCurrent);
  const reportedStepPowerW = resolveActiveTargetPowerW(
    device, config, nativeEvOverlay.capabilityObj, observedTargetPower,
    manualControl,
  );
  // All-or-nothing: no ladder means no stepped control, so the synthetic
  // `target_power` capability is not injected either and the device is left to
  // whatever axis it exposes natively.
  const steppedControl = resolveTargetPowerSteppedControl(config, reportedStepPowerW);
  if (!steppedControl) {
    return {
      capabilities: nativeEvOverlay.capabilities,
      capabilityObj: nativeEvOverlay.capabilityObj,
    };
  }
  const steppedLoadProfile = steppedControl.profile;
  const capabilityObj = buildSyntheticTargetPowerCapabilityMap({
    capabilityObj: nativeEvOverlay.capabilityObj,
    config,
    observedValue: reportedStepPowerW,
    observedAt: observedTargetPower?.observedAt ?? nativeEvOverlay.capabilityObj.target_power?.lastUpdated,
  });
  return {
    capabilities,
    capabilityObj,
    steppedLoadProfile,
    ...resolveSyntheticStepObservation(steppedLoadProfile, capabilities, capabilityObj, manualControl),
    reportedStepPowerW,
    acknowledgedStep: resolveAcknowledgedStepObservation(
      config, nativeEvOverlay.capabilityObj[ACKNOWLEDGED_CURRENT_CAPABILITY_ID],
    ),
    targetPowerConfig: withoutTargetPowerReachability(config),
  };
}

function usesManualCurrentControl(device: HomeyDeviceLike, automatic: AutomaticPowerControl | undefined): boolean {
  return automatic?.mode === 'manual' && getDeviceAdapter(device).currentBindings(device).length > 0;
}

function resolveSyntheticStepObservation(
  profile: SteppedLoadProfile, capabilityIds: readonly string[],
  capabilities: DeviceCapabilityMap, manualControl: boolean,
): Pick<ReportedStepObservedProbe, 'reportedStepId' | 'reportedStepObservedAtMs'> {
  // A vendor watt target is dormant while the owner uses the manual current path.
  const { target_power_mode: _mode, ...manualCapabilities } = capabilities;
  const capabilityObj = manualControl ? manualCapabilities : capabilities;
  const observedIds = manualControl ? capabilityIds.filter((id) => id !== 'target_power_mode') : capabilityIds;
  return {
    reportedStepId: resolveTargetPowerReportedStepId(profile, observedIds, capabilityObj),
    reportedStepObservedAtMs: resolveTargetPowerModeInvalidationAtMs(capabilityObj, observedIds)
      ?? toCapabilityTimestampMs(capabilityObj.target_power?.lastUpdated),
  };
}

function resolveActiveTargetPowerW(
  device: HomeyDeviceLike,
  config: TargetPowerSteppedLoadConfig,
  capabilityObj: DeviceCapabilityMap,
  observation: ReturnType<typeof resolveInstallationCurrentTargetPowerObservation>,
  manualControl: boolean,
): number | undefined {
  if (!manualControl && !isTargetPowerControlActive(capabilityObj, device.capabilities ?? [])) return undefined;
  return observation?.value ?? resolveReportedTargetPowerW(device, config, capabilityObj);
}

function resolveReportedTargetPowerW(
  device: HomeyDeviceLike,
  config: TargetPowerSteppedLoadConfig,
  capabilityObj: DeviceCapabilityMap,
): number | undefined {
  const directTargetPower = capabilityObj.target_power?.value;
  return typeof directTargetPower === 'number' && Number.isFinite(directTargetPower)
    ? Math.round(getDeviceAdapter(device).targetPowerReading(device, config, directTargetPower))
    : undefined;
}

function isEvTargetPowerPresetConfig(
  config: TargetPowerSteppedLoadConfig | undefined,
): boolean {
  return config?.preset === 'ev_charger_1_phase' || config?.preset === 'ev_charger_3_phase';
}

function resolveInstallationCurrentTargetPowerObservation(
  config: TargetPowerSteppedLoadConfig,
  current: DeviceCapabilityMap[string],
): { value: number; observedAt?: DeviceCapabilityMap[string]['lastUpdated'] } | undefined {
  const phaseCount = resolveTargetPowerPresetPhaseCount(config.preset);
  if (!phaseCount || typeof current.value !== 'number' || !Number.isFinite(current.value)) return undefined;
  return {
    value: Math.round(current.value * 230 * phaseCount),
    observedAt: current.lastUpdated,
  };
}

/**
 * Native watt devices arrive with their published ladder intact. A configured
 * fallback supplies the ladder for amp controls and devices without a usable
 * published watt range.
 */
function resolveNativeSteppedLoadOverlay(
  device: HomeyDeviceLike,
  deviceId: string,
  targetPowerOverlay: ReturnType<typeof applySyntheticTargetPowerOverlay>,
  sources: DeviceParseSources,
  automaticPowerControl: AutomaticPowerControl | undefined,
): {
  controlAdapter?: DeviceControlAdapterSnapshot;
  reportedStepId?: string;
  reportedStepObservedAtMs?: number;
  suggestedSteppedLoadProfile?: SteppedLoadProfile;
} {
  const { capabilities, capabilityObj, targetPowerConfig } = targetPowerOverlay;
  const targetPowerSteppedCandidate = isTargetPowerSteppedLoadCandidate({ capabilities, capabilityObj });
  const nativeSteppedCandidate = isNativeSteppedLoadWiringCandidate({
    device,
    capabilities,
    capabilityObj,
  });
  const suggestedSteppedLoadProfile = targetPowerOverlay.steppedLoadProfile
    ?? resolveNativeSteppedLoadProfileSuggestion({ device, capabilities, capabilityObj });
  if (!nativeSteppedCandidate || !suggestedSteppedLoadProfile) return {};
  // A derived current model and an EV preset both carry amp commands. A manual
  // continuous watt ladder still needs its Flow to express that conversion.
  const automatic = automaticPowerControl?.mode === 'automatic';
  const currentControl = getDeviceAdapter(device).nativeCurrentControls
    .some((control) => control.accepts(device, capabilityObj));
  if (!automatic && currentControl
    && !isEvTargetPowerPresetConfig(targetPowerConfig)) return {};

  const nativeSteppedEnabled = targetPowerSteppedCandidate || sources.nativeWiring.resolveNativeWiringEnabled(deviceId);
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
    reportedStepObservedAtMs: resolveTargetPowerModeInvalidationAtMs(capabilityObj, capabilities) ?? (reportedStepId
      ? resolveNativeSteppedLoadObservedAtMs(capabilities, capabilityObj)
      : undefined),
    suggestedSteppedLoadProfile,
  };
}

function resolveNativeSteppedLoadObservedAtMs(
  capabilities: readonly string[],
  capabilityObj: DeviceCapabilityMap,
): number | undefined {
  const nativeCapabilityId = resolveNativeSteppedLoadObservationCapabilityId({ capabilities, capabilityObj });
  return toCapabilityTimestampMs(
    nativeCapabilityId ? capabilityObj[nativeCapabilityId]?.lastUpdated : undefined,
  );
}

function pickSupplementalFlowReports(
  reportedCapabilities: FlowReportedCapabilitiesForDevice,
): FlowReportedCapabilitiesForDevice {
  return reportedCapabilities.measure_battery
    ? { measure_battery: reportedCapabilities.measure_battery }
    : {};
}

export function resolveCandidateCapabilities(
  identity: Pick<ParsedDeviceIdentity, 'deviceClassKey' | 'deviceId' | 'deviceLabel'>,
  overlay: Pick<
    ReturnType<typeof resolveFlowCapabilityOverlay>,
    'capabilities' | 'controlAdapter' | 'steppedLoadProfile'
  >,
): { targetCaps: string[]; hasPower: boolean } | null {
  const { deviceClassKey, deviceId, deviceLabel } = identity;
  const { capabilities, controlAdapter, steppedLoadProfile } = overlay;
  // Plug state is an independent observation, not a prerequisite for the
  // charger's valid power/control facets. Session and start owners require
  // an accepted plug observation separately.
  if (deviceClassKey === 'evcharger' && steppedLoadProfile !== undefined) {
    return { targetCaps: [], hasPower: hasAnyPowerCapability(capabilities) };
  }
  if (deviceClassKey === 'evcharger' && isCapabilityAdapterEvCandidate(controlAdapter)
    && !capabilities.includes('evcharger_charging')) {
    return { targetCaps: [], hasPower: hasAnyPowerCapability(capabilities) };
  }
  const resolved = resolveDeviceCapabilities({
    deviceClassKey,
    deviceId,
    deviceLabel,
    capabilities,
  });
  if (resolved) return resolved;
  // A stepped-load profile is an independent control facet. Missing or invalid
  // temperature capabilities must not evict a device whose usable ladder was
  // already admitted by the stepped producer.
  if (steppedLoadProfile !== undefined) {
    return {
      targetCaps: [],
      hasPower: hasAnyPowerCapability(capabilities),
    };
  }
  return null;
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
