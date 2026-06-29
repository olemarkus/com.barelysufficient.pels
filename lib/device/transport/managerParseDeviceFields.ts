import type {
  DeviceStateOfChargeSnapshot,
  EvChargingState,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import {
    getCapabilities,
    resolveZoneLabel,
} from './managerHelpers';
import { estimatePower, type PowerEstimateState } from '../devicePowerEstimate';
import {
    type FlowReportedCapabilityId,
    type FlowReportedCapabilitiesForDevice,
} from './flowReportedCapabilities';
import {
  getControlCapabilityId,
  getEvCharging,
  getEvChargingState,
  resolveEvChargingStateBinaryEvidence,
  type DeviceCapabilityMap,
} from '../managerControl';
import {
    buildTargets,
    getCurrentTemperature,
    resolveDeviceCapabilities,
} from './managerParse';
import {
    isObserveOnlyRoleDevice,
    type LiveDevicePowerWatts,
} from '../managerEnergy';
import { updateLastKnownPower } from '../managerRuntime';
import type { DeviceMeasuredPowerResolver } from '../measuredPowerResolver';
import { resolveMeasuredPowerKw } from '../managerMeasuredPower';
import {
    resolveCandidateCapabilities,
    resolveFlowCapabilityOverlay,
} from '../managerNativeEv';
import { shouldSkipFlowBackedCandidate } from '../managerFlowSupport';
import {
    resolveLastFreshDataMs,
    resolveBinaryControlObservation,
} from './managerParseSnapshot';
import { resolveStateOfChargeSnapshot } from './stateOfCharge';
import { resolveDeviceParsedControlState } from './managerParsedControlState';
import { resolveAvailable as resolveAvail } from './managerParsedAvailability';
import type { ParsedDeviceIdentity } from './managerParseIdentity';
import {
    shouldDropAfterControlState,
    type ManagedFilterDecision,
} from './managerManagedFilter';
import type {
    DeviceTransportParseDeps,
    DeviceTransportParseProviders,
    ParseDevicePurpose,
} from './managerParseDevice';

type ParsedDeviceSettings = Pick<
    TargetDeviceSnapshot,
    'communicationModel' | 'priority' | 'controllable' | 'managed' | 'budgetExempt' | 'flowConflict'
>;

type DeviceCapabilityProfile = {
    overlay: ReturnType<typeof resolveFlowCapabilityOverlay>;
    capsStatus: NonNullable<ReturnType<typeof resolveDeviceCapabilities>>;
};

type DeviceControlBundle = {
    controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
    evCharging: TargetDeviceSnapshot['evCharging'];
    evChargingState: EvChargingState | undefined;
    binaryControl: TargetDeviceSnapshot['binaryControl'];
    canSetControl: boolean | undefined;
    available: boolean;
    powerCapable: boolean;
    lastFreshDataMs?: number;
};

export function resolveDeviceCapabilityProfile(params: {
    identity: ParsedDeviceIdentity;
    deps: DeviceTransportParseDeps;
}): DeviceCapabilityProfile | null {
    const { identity, deps } = params;
    const { effectiveDevice, deviceClassKey, deviceId, deviceLabel } = identity;
    const { providers, logger, getCapabilityObj, debugStructured } = deps;
    const rawCapabilities = getCapabilities(effectiveDevice);
    const rawCapabilityObj = getCapabilityObj(effectiveDevice);
    const overlay = resolveFlowCapabilityOverlay({
        device: effectiveDevice,
        deviceClassKey,
        deviceId,
        rawCapabilities,
        rawCapabilityObj,
        providers,
        logger,
    });
    const capsStatus = resolveCandidateCapabilities({
        deviceClassKey,
        deviceId,
        deviceLabel,
        capabilities: overlay.capabilities,
        controlAdapter: overlay.controlAdapter,
        steppedLoadProfile: overlay.steppedLoadProfile,
        debugStructured,
    });
    if (!capsStatus) return null;
    return { overlay, capsStatus };
}

function resolveDeviceControlBundle(params: {
    identity: ParsedDeviceIdentity;
    deps: DeviceTransportParseDeps;
    overlay: DeviceCapabilityProfile['overlay'];
    capsStatus: DeviceCapabilityProfile['capsStatus'];
    powerEstimate: ReturnType<typeof estimatePower>;
    measuredPower: ReturnType<typeof resolveMeasuredPowerKw>;
    previousSnapshot?: TransportDeviceSnapshot;
    purpose: ParseDevicePurpose;
    managedDecision: ManagedFilterDecision;
}): DeviceControlBundle | null {
    const {
        identity, deps, overlay, capsStatus, powerEstimate, measuredPower,
        previousSnapshot, purpose, managedDecision,
    } = params;
    const { effectiveDevice, deviceId, deviceClassKey, deviceLabel } = identity;
    const { logger, debugStructured, isPowerCapable } = deps;
    const controlCapabilityId = getControlCapabilityId({
        deviceClassKey, capabilities: overlay.capabilities,
    });
    const evCharging = getEvCharging(overlay.capabilityObj);
    const evChargingState = getEvChargingState(overlay.capabilityObj);
    const { resolvedOn, binaryControl, canSetControl, observedCurrentOn, hasTrustedControlState }
        = resolveDeviceParsedControlState({
        logger,
        debugStructured, deviceId, deviceName: effectiveDevice.name ?? null,
        deviceLabel,
        deviceClassKey,
        controlCapabilityId,
        controlWriteCapabilityId: overlay.controlWriteCapabilityId,
        capabilityObj: overlay.capabilityObj,
        evCharging,
        evChargingState,
        flowBackedCapabilityIds: overlay.flowBackedCapabilityIds,
        previousSnapshot,
        suppressDropLog: purpose === 'ui_picker',
    });
    if (shouldDropAfterControlState({
        purpose, decision: managedDecision, currentOn: resolvedOn, deviceClassKey,
    })) {
        return null;
    }
    const available = resolveAvail(
        controlCapabilityId, hasTrustedControlState, overlay.steppedLoadProfile, effectiveDevice,
    );
    const powerCapable = isPowerCapable(effectiveDevice, capsStatus, powerEstimate);
    if (shouldSkipFlowBackedCandidate({
        flowAugmentedDeviceType: overlay.flowAugmentedDeviceType,
        flowBackedCapabilityIds: overlay.flowBackedCapabilityIds,
        capabilities: overlay.capabilities, capabilityObj: overlay.capabilityObj,
        requiredFlowCapabilityIds: overlay.requiredFlowCapabilityIds,
        reportedCapabilities: overlay.reportedCapabilities, powerCapable,
    })) {
        return null;
    }
    const lastFreshDataMs = resolveParsedLastFreshDataMs({
        capabilityObj: overlay.capabilityObj, controlCapabilityId, observedCurrentOn, evChargingState,
        targetCaps: capsStatus.targetCaps,
        reportedStepObservedAtMs: overlay.reportedStepObservedAtMs,
        measuredPowerObservedAtMs: measuredPower.observedAtMs,
    });
    return {
        controlCapabilityId, evCharging, evChargingState, binaryControl, canSetControl,
        available, powerCapable, lastFreshDataMs,
    };
}

export function assembleDeviceSnapshot(params: {
    identity: ParsedDeviceIdentity;
    deps: DeviceTransportParseDeps;
    overlay: DeviceCapabilityProfile['overlay'];
    capsStatus: DeviceCapabilityProfile['capsStatus'];
    now: number;
    livePowerWByDeviceId: LiveDevicePowerWatts;
    previousSnapshot?: TransportDeviceSnapshot;
    purpose: ParseDevicePurpose;
    managedDecision: ManagedFilterDecision;
}): TransportDeviceSnapshot | null {
    const {
        identity, deps, overlay, capsStatus, now, livePowerWByDeviceId,
        previousSnapshot, purpose, managedDecision,
    } = params;
    const { effectiveDevice, deviceId, deviceClassKey, deviceLabel } = identity;
    const { providers, debugStructured, resolveLatestLocalWriteMs } = deps;
    const { currentTemperature, measuredPower, powerEstimate } = resolveDevicePowerState({
        device: effectiveDevice,
        deviceId,
        deviceLabel,
        capabilities: overlay.capabilities,
        capabilityObj: overlay.capabilityObj,
        livePowerWByDeviceId,
        now,
        measuredPowerResolver: deps.measuredPowerResolver,
        powerState: deps.powerState,
        logger: deps.logger,
    });
    const targetCaps = capsStatus.targetCaps;
    const targets = buildTargets({
        targetCaps, capabilityObj: overlay.capabilityObj, deviceId, deviceLabel,
        debugStructured,
    });
    const control = resolveDeviceControlBundle({
        identity, deps, overlay, capsStatus, powerEstimate, measuredPower,
        previousSnapshot, purpose, managedDecision,
    });
    if (!control) return null;
    return buildParsedDeviceSnapshot({
        device: effectiveDevice,
        deviceId,
        deviceClassKey,
        providers,
        targets,
        targetCaps,
        controlCapabilityId: control.controlCapabilityId,
        powerEstimate,
        powerCapable: control.powerCapable,
        binaryControl: control.binaryControl,
        evCharging: control.evCharging,
        evChargingState: control.evChargingState,
        stateOfCharge: resolveParsedSoc(
            deviceClassKey, now, overlay.capabilityObj, overlay.reportedCapabilities,
        ),
        currentTemperature,
        capabilities: overlay.capabilities,
        flowBackedCapabilityIds: overlay.flowBackedCapabilityIds,
        controlAdapter: overlay.controlAdapter,
        controlWriteCapabilityId: overlay.controlWriteCapabilityId,
        controlObservationCapabilityId: overlay.controlObservationCapabilityId,
        controlModel: overlay.controlModel,
        steppedLoadProfile: overlay.steppedLoadProfile,
        nativeWriteCapabilities: overlay.nativeWriteCapabilities,
        targetPowerConfig: overlay.targetPowerConfig,
        canSetControl: control.canSetControl,
        binaryControlObservation: resolveBinaryControlObservation({
            capabilityObj: overlay.capabilityObj,
            controlCapabilityId: control.controlCapabilityId,
            controlObservationCapabilityId: overlay.controlObservationCapabilityId,
        }),
        available: control.available,
        reportedStepId: overlay.reportedStepId,
        suggestedSteppedLoadProfile: overlay.suggestedSteppedLoadProfile,
        measuredPowerObservedAtMs: measuredPower.observedAtMs,
        lastFreshDataMs: control.lastFreshDataMs,
        lastLocalWriteMs: resolveLatestLocalWriteMs(deviceId),
    });
}

function resolveParsedLastFreshDataMs(params: {
    capabilityObj: DeviceCapabilityMap;
    controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
    observedCurrentOn?: boolean;
    evChargingState: EvChargingState | undefined;
    targetCaps: readonly string[];
    reportedStepObservedAtMs?: number;
    measuredPowerObservedAtMs?: number;
}): number | undefined {
    const {
        capabilityObj, controlCapabilityId, observedCurrentOn, evChargingState,
        targetCaps, reportedStepObservedAtMs, measuredPowerObservedAtMs,
    } = params;
    return resolveLastFreshDataMs({
        capabilityObj,
        controlCapabilityId: observedCurrentOn !== undefined ? controlCapabilityId : undefined,
        includeEvChargingState: evChargingState === undefined
            || resolveEvChargingStateBinaryEvidence(evChargingState) !== undefined,
        targetCaps,
        observedCapabilityAtMs: reportedStepObservedAtMs,
        measuredPowerObservedAtMs,
    });
}

function resolveTargetDeviceType(targetCaps: readonly string[]): TargetDeviceSnapshot['deviceType'] {
    return targetCaps.length > 0 ? 'temperature' : 'onoff';
}

function resolveParsedSoc(
    deviceClassKey: string,
    nowMs: number,
    capabilityObj: DeviceCapabilityMap,
    reportedCapabilities: FlowReportedCapabilitiesForDevice,
): DeviceStateOfChargeSnapshot | undefined {
    return resolveStateOfChargeSnapshot({
        deviceClassKey,
        nowMs,
        capabilityObj,
        reportedCapabilities,
    });
}

function buildParsedDeviceSnapshot(params: {
    device: HomeyDeviceLike;
    deviceId: string;
    deviceClassKey: string;
    providers: DeviceTransportParseProviders;
    targets: TargetDeviceSnapshot['targets'];
    targetCaps: readonly string[];
    controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
    powerEstimate: ReturnType<typeof estimatePower>;
    powerCapable: boolean;
    binaryControl: TargetDeviceSnapshot['binaryControl'];
    evCharging: TargetDeviceSnapshot['evCharging'];
    evChargingState: EvChargingState | undefined;
    stateOfCharge: DeviceStateOfChargeSnapshot | undefined;
    currentTemperature: number | undefined;
    capabilities: string[];
    flowBackedCapabilityIds: FlowReportedCapabilityId[];
    controlAdapter?: TargetDeviceSnapshot['controlAdapter'];
    controlWriteCapabilityId?: string;
    controlObservationCapabilityId?: string;
    controlModel?: TargetDeviceSnapshot['controlModel'];
    steppedLoadProfile?: SteppedLoadProfile;
    nativeWriteCapabilities?: TargetDeviceSnapshot['nativeWriteCapabilities'];
    targetPowerConfig?: TargetPowerSteppedLoadConfig;
    canSetControl: boolean | undefined;
    binaryControlObservation: TargetDeviceSnapshot['binaryControlObservation'];
    available: boolean;
    reportedStepId?: string;
    suggestedSteppedLoadProfile?: TargetDeviceSnapshot['suggestedSteppedLoadProfile'];
    measuredPowerObservedAtMs?: number;
    lastFreshDataMs?: number;
    lastLocalWriteMs?: number;
}): TransportDeviceSnapshot {
    const {
        device,
        deviceId,
        deviceClassKey,
        providers,
        targets,
        targetCaps,
        controlCapabilityId,
        powerEstimate,
        powerCapable,
        binaryControl,
        evCharging,
        evChargingState,
        stateOfCharge,
        currentTemperature,
        capabilities,
        flowBackedCapabilityIds,
        controlAdapter,
        controlWriteCapabilityId,
        controlObservationCapabilityId,
        controlModel,
        steppedLoadProfile,
        nativeWriteCapabilities,
        targetPowerConfig,
        canSetControl,
        binaryControlObservation,
        available,
        reportedStepId,
        suggestedSteppedLoadProfile,
        measuredPowerObservedAtMs,
        lastFreshDataMs,
        lastLocalWriteMs,
    } = params;

    return {
        id: deviceId,
        name: device.name,
        targets,
        deviceClass: deviceClassKey,
        deviceType: resolveTargetDeviceType(targetCaps),
        ...resolveParsedDeviceSettings(device, deviceId, providers),
        controlModel,
        steppedLoadProfile,
        nativeWriteCapabilities,
        targetPowerConfig,
        controlCapabilityId,
        powerKw: powerEstimate.powerKw,
        expectedPowerKw: powerEstimate.expectedPowerKw,
        expectedPowerSource: powerEstimate.expectedPowerSource,
        loadKw: powerEstimate.loadKw,
        powerCapable,
        binaryControl,
        evCharging,
        evChargingState,
        stateOfCharge,
        currentTemperature,
        measuredPowerKw: powerEstimate.measuredPowerKw,
        measuredPowerObservedAtMs,
        zone: resolveZoneLabel(device),
        capabilities,
        controlAdapter,
        controlWriteCapabilityId,
        controlObservationCapabilityId,
        binaryControlObservation,
        reportedStepId,
        suggestedSteppedLoadProfile,
        ...(flowBackedCapabilityIds.length > 0 ? {
            flowBacked: true,
            flowBackedCapabilityIds,
        } : {}),
        canSetControl,
        available,
        lastFreshDataMs,
        lastLocalWriteMs,
        lastUpdated: lastFreshDataMs,
    };
}

function resolveDevicePowerState(params: {
    device: HomeyDeviceLike;
    deviceId: string;
    deviceLabel: string;
    capabilities: string[];
    capabilityObj: DeviceCapabilityMap;
    livePowerWByDeviceId: LiveDevicePowerWatts;
    now: number;
    measuredPowerResolver: DeviceMeasuredPowerResolver;
    powerState: Required<PowerEstimateState>;
    logger: Logger;
}): {
    currentTemperature: number | undefined;
    measuredPower: ReturnType<typeof resolveMeasuredPowerKw>;
    powerEstimate: ReturnType<typeof estimatePower>;
} {
    const {
        device,
        deviceId,
        deviceLabel,
        capabilities,
        capabilityObj,
        livePowerWByDeviceId,
        now,
        measuredPowerResolver,
        powerState,
        logger,
    } = params;
    const currentTemperature = getCurrentTemperature(capabilityObj);
    const measuredPower = resolveMeasuredPowerKw({
        deviceId,
        deviceLabel,
        capabilities,
        capabilityObj,
        livePowerWByDeviceId,
        now,
        measuredPowerResolver,
        powerState,
        logger,
    });
    const powerEstimate = estimatePower({
        device,
        deviceId,
        deviceLabel,
        measuredPowerKw: measuredPower.measuredPowerKw,
        now,
        state: powerState,
        logger,
        updateLastKnownPower: (id, kw, label) => updateLastKnownPower({
            state: powerState,
            logger,
            deviceId: id,
            measuredKw: kw,
            deviceLabel: label,
        }),
    });
    return {
        currentTemperature,
        measuredPower,
        powerEstimate,
    };
}

function resolveParsedDeviceSettings(
    device: HomeyDeviceLike,
    deviceId: string,
    providers: DeviceTransportParseProviders,
): ParsedDeviceSettings {
    const base = {
        communicationModel: providers.getCommunicationModel?.(deviceId) ?? 'local',
        priority: providers.getPriority?.(deviceId),
        controllable: providers.getControllable?.(deviceId),
        managed: providers.getManaged?.(deviceId),
        budgetExempt: providers.getBudgetExempt?.(deviceId),
        flowConflict: providers.getFlowConflict?.(deviceId),
    };
    // A role-detected OBSERVE-ONLY device (home battery OR solar) is stamped MANAGED
    // OBSERVE-ONLY STRUCTURALLY, from the device object in hand — independent of any
    // async-populated id set. This is the single authoritative resolution: it applies on
    // EVERY parse path (full refresh AND realtime `device.update`), so there is no window
    // (boot, realtime-before-first-full-refresh, or any settings combo) where a present
    // battery/solar device resolves `controllable: true` or enters the planner
    // controllable/actuated. The app's `resolveManagedState`/`isCapacityControlEnabled`
    // agree via the transport's observe-only-id set; the planner reads THIS structural
    // stamp on the snapshot, never the settings-derived flags. Detection
    // (`isObserveOnlyRoleDevice`) is the SAME predicate the class-key normalization /
    // snapshot-survival gates use, so detection, stamping, and survival can never diverge
    // (an energy-role-only battery/solar device is detected, stamped, AND survives).
    return isObserveOnlyRoleDevice(device) ? { ...base, managed: true, controllable: false } : base;
}
