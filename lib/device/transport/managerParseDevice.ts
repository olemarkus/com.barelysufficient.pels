import type { DeviceControlProfile, TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import {
    getCapabilities,
    getDeviceId,
    getIsAvailable,
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
    hasPotentialHomeyEnergyEstimate,
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
import type { StructuredDebugEmitter } from '../../logging/logger';
import { resolveDeviceParsedControlState } from './managerParsedControlState';
import { resolveParseDeviceIdentity } from './managerParseIdentity';
import {
    resolveManagedFilterDecision,
    shouldDropAfterControlState,
    shouldDropEarly,
} from './managerManagedFilter';

type ParsedDeviceSettings = Pick<
    TargetDeviceSnapshot,
    'communicationModel' | 'priority' | 'controllable' | 'managed' | 'budgetExempt' | 'flowConflict'
>;

export type DeviceTransportParseProviders = {
    getPriority?: (deviceId: string) => number;
    getControllable?: (deviceId: string) => boolean;
    getManaged?: (deviceId: string) => boolean;
    isManagedFilterActive?: () => boolean;
    getBudgetExempt?: (deviceId: string) => boolean;
    getCommunicationModel?: (deviceId: string) => 'local' | 'cloud';
    getDeviceDriverIdOverride?: (deviceId: string) => string | undefined;
    getNativeEvWiringEnabled?: (deviceId: string) => boolean;
    getFlowConflict?: (deviceId: string) => TargetDeviceSnapshot['flowConflict'];
    getDeviceControlProfile?: (deviceId: string) => DeviceControlProfile | undefined;
    getDeviceTargetPowerConfig?: (deviceId: string) => TargetDeviceSnapshot['targetPowerConfig'];
    getFlowReportedCapabilities?: (deviceId: string) => FlowReportedCapabilitiesForDevice;
};

export type DeviceTransportParseDeps = {
    logger: Logger;
    debugStructured?: StructuredDebugEmitter;
    providers: DeviceTransportParseProviders;
    powerState: Required<PowerEstimateState>;
    measuredPowerResolver: DeviceMeasuredPowerResolver;
    getCapabilityObj: (device: HomeyDeviceLike) => DeviceCapabilityMap;
    isPowerCapable: (
        device: HomeyDeviceLike,
        capsStatus: NonNullable<ReturnType<typeof resolveDeviceCapabilities>>,
        powerEstimate: ReturnType<typeof estimatePower>,
    ) => boolean;
    resolveLatestLocalWriteMs: (deviceId: string) => number | undefined;
};

export type ParseDevicePurpose = 'runtime' | 'ui_picker' | 'unfiltered';

export function parseDeviceList(params: {
    list: HomeyDeviceLike[];
    livePowerWByDeviceId?: LiveDevicePowerWatts;
    previousSnapshotById?: ReadonlyMap<string, TargetDeviceSnapshot>;
    deps: DeviceTransportParseDeps;
    purpose?: ParseDevicePurpose;
}): TargetDeviceSnapshot[] {
    const { list, livePowerWByDeviceId = {}, previousSnapshotById, deps, purpose = 'runtime' } = params;
    const now = Date.now();
    return list
        .map((device) => parseDevice({
            device,
            now,
            livePowerWByDeviceId,
            previousSnapshot: previousSnapshotById?.get(getDeviceId(device)),
            deps,
            purpose,
        }))
        .filter(Boolean) as TargetDeviceSnapshot[];
}

export function parseDevice(params: {
    device: HomeyDeviceLike;
    now: number;
    livePowerWByDeviceId?: LiveDevicePowerWatts;
    previousSnapshot?: TargetDeviceSnapshot;
    deps: DeviceTransportParseDeps;
    purpose?: ParseDevicePurpose;
}): TargetDeviceSnapshot | null {
    const { device, now, livePowerWByDeviceId = {}, previousSnapshot, deps, purpose = 'runtime' } = params;
    const {
        logger,
        providers,
        powerState,
        measuredPowerResolver,
        getCapabilityObj,
        isPowerCapable,
        resolveLatestLocalWriteMs,
    } = deps;

    const identity = resolveParseDeviceIdentity({ device });
    if (!identity) return null;
    const {
        deviceId,
        effectiveDevice,
        deviceClassKey,
        deviceLabel,
    } = identity;
    const managedDecision = resolveManagedFilterDecision({ providers, deviceId });
    if (shouldDropEarly({ purpose, decision: managedDecision })) return null;
    const rawCapabilities = getCapabilities(effectiveDevice);
    const rawCapabilityObj = getCapabilityObj(effectiveDevice);
    const {
        capabilities,
        capabilityObj,
        controlAdapter,
        controlWriteCapabilityId,
        controlObservationCapabilityId,
        flowAugmentedDeviceType,
        flowBackedCapabilityIds,
        requiredFlowCapabilityIds,
        reportedCapabilities,
        reportedStepId, reportedStepObservedAtMs,
        suggestedSteppedLoadProfile,
        controlModel,
        steppedLoadProfile,
        nativeWriteCapabilities,
        targetPowerConfig,
    } = resolveFlowCapabilityOverlay({
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
        capabilities,
        controlAdapter,
        steppedLoadProfile,
        logDebug: (...args: unknown[]) => logger.debug(...args),
    });
    if (!capsStatus) return null;
    const { currentTemperature, measuredPower, powerEstimate } = resolveDevicePowerState({
        device: effectiveDevice,
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
    const targetCaps = capsStatus.targetCaps;
    const targets = buildTargets({
        targetCaps,
        capabilityObj,
        deviceLabel,
        logDebug: (...args: unknown[]) => logger.debug(...args),
    });
    const controlCapabilityId = getControlCapabilityId({ deviceClassKey, capabilities });
    const evCharging = getEvCharging(capabilityObj);
    const evChargingState = getEvChargingState(capabilityObj);
    const { currentOn, canSetControl, observedCurrentOn } = resolveDeviceParsedControlState({
        logger,
        debugStructured: deps.debugStructured, deviceId, deviceName: effectiveDevice.name ?? null,
        deviceLabel,
        deviceClassKey,
        controlCapabilityId,
        controlWriteCapabilityId,
        capabilityObj,
        evCharging,
        evChargingState,
        flowBackedCapabilityIds,
        previousSnapshot,
        suppressDropLog: purpose === 'ui_picker',
    });
    if (shouldDropAfterControlState({ purpose, decision: managedDecision, currentOn })) return null;
    const available = getIsAvailable(effectiveDevice);
    const powerCapable = isPowerCapable(effectiveDevice, capsStatus, powerEstimate);
    if (shouldSkipFlowBackedCandidate({
        flowAugmentedDeviceType, flowBackedCapabilityIds, capabilities, capabilityObj,
        requiredFlowCapabilityIds, reportedCapabilities, powerCapable,
    })) {
        return null;
    }
    const lastFreshDataMs = resolveParsedLastFreshDataMs({
        capabilityObj, controlCapabilityId, observedCurrentOn, evChargingState,
        targetCaps, reportedStepObservedAtMs, measuredPowerObservedAtMs: measuredPower.observedAtMs,
    });
    return buildParsedDeviceSnapshot({
        device: effectiveDevice,
        deviceId,
        deviceClassKey,
        providers,
        targets,
        targetCaps,
        controlCapabilityId,
        powerEstimate,
        powerCapable,
        currentOn: currentOn ?? false,
        evCharging,
        evChargingState,
        stateOfCharge: resolveParsedSoc(
            deviceClassKey, now, capabilityObj, reportedCapabilities,
        ),
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
        binaryControlObservation: resolveBinaryControlObservation(
            { capabilityObj, controlCapabilityId, controlObservationCapabilityId },
        ),
        available,
        reportedStepId, suggestedSteppedLoadProfile, measuredPowerObservedAtMs: measuredPower.observedAtMs,
        lastFreshDataMs,
        lastLocalWriteMs: resolveLatestLocalWriteMs(deviceId),
    });
}

function resolveParsedLastFreshDataMs(params: {
    capabilityObj: DeviceCapabilityMap;
    controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
    observedCurrentOn?: boolean;
    evChargingState: TargetDeviceSnapshot['evChargingState'];
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
): TargetDeviceSnapshot['stateOfCharge'] {
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
    currentOn: boolean;
    evCharging: TargetDeviceSnapshot['evCharging'];
    evChargingState: TargetDeviceSnapshot['evChargingState'];
    stateOfCharge: TargetDeviceSnapshot['stateOfCharge'];
    currentTemperature: TargetDeviceSnapshot['currentTemperature'];
    capabilities: string[];
    flowBackedCapabilityIds: FlowReportedCapabilityId[];
    controlAdapter?: TargetDeviceSnapshot['controlAdapter'];
    controlWriteCapabilityId?: string;
    controlObservationCapabilityId?: string;
    controlModel?: TargetDeviceSnapshot['controlModel'];
    steppedLoadProfile?: TargetDeviceSnapshot['steppedLoadProfile'];
    nativeWriteCapabilities?: TargetDeviceSnapshot['nativeWriteCapabilities'];
    targetPowerConfig?: TargetDeviceSnapshot['targetPowerConfig'];
    canSetControl: boolean | undefined;
    binaryControlObservation: TargetDeviceSnapshot['binaryControlObservation'];
    available: boolean;
    reportedStepId?: string;
    suggestedSteppedLoadProfile?: TargetDeviceSnapshot['suggestedSteppedLoadProfile'];
    measuredPowerObservedAtMs?: number;
    lastFreshDataMs?: number;
    lastLocalWriteMs?: number;
}): TargetDeviceSnapshot {
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
        currentOn,
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
        ...resolveParsedDeviceSettings(deviceId, providers),
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
        currentOn,
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
    deviceId: string,
    providers: DeviceTransportParseProviders,
): ParsedDeviceSettings {
    return {
        communicationModel: providers.getCommunicationModel?.(deviceId) ?? 'local',
        priority: providers.getPriority?.(deviceId),
        controllable: providers.getControllable?.(deviceId),
        managed: providers.getManaged?.(deviceId),
        budgetExempt: providers.getBudgetExempt?.(deviceId),
        flowConflict: providers.getFlowConflict?.(deviceId),
    };
}

export function isDevicePowerCapable(params: {
    device: HomeyDeviceLike;
    capsStatus: NonNullable<ReturnType<typeof resolveDeviceCapabilities>>;
    powerEstimate: ReturnType<typeof estimatePower>;
}): boolean {
    const { device, capsStatus, powerEstimate } = params;
    return capsStatus.hasPower
        || typeof powerEstimate.loadKw === 'number'
        || typeof powerEstimate.measuredPowerKw === 'number'
        || hasPotentialHomeyEnergyEstimate(device)
        || powerEstimate.hasEnergyEstimate === true;
}
