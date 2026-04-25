import type {
    HomeyDeviceLike,
    Logger,
    TargetDeviceSnapshot,
} from '../utils/types';
import {
    getCapabilities,
    getDeviceId,
    getIsAvailable,
    resolveDeviceClassKey,
    resolveDeviceLabel,
    resolveZoneLabel,
} from './deviceManagerHelpers';
import { estimatePower, type PowerEstimateState } from './powerEstimate';
import {
    type FlowReportedCapabilityId,
    type FlowReportedCapabilitiesForDevice,
} from './flowReportedCapabilities';
import {
  getControlCapabilityId,
  getEvCharging,
  getCurrentOn,
  getEvChargingState,
  type DeviceCapabilityMap,
} from './deviceManagerControl';
import {
    buildTargets,
    getCurrentTemperature,
    resolveDeviceCapabilities,
} from './deviceManagerParse';
import {
    hasPotentialHomeyEnergyEstimate,
    type LiveDevicePowerWatts,
} from './deviceManagerEnergy';
import { updateLastKnownPower } from './deviceManagerRuntime';
import type { DeviceMeasuredPowerResolver } from './deviceMeasuredPowerResolver';
import { resolveMeasuredPowerKw } from './deviceManagerMeasuredPower';
import {
    resolveCandidateCapabilities,
    resolveFlowCapabilityOverlay,
} from './deviceManagerNativeEv';
import { shouldSkipFlowBackedCandidate } from './deviceManagerFlowSupport';
import {
    resolveLastFreshDataMs,
    resolveParsedControlState,
} from './deviceManagerParseSnapshot';

type ParsedDeviceSettings = Pick<
    TargetDeviceSnapshot,
    'communicationModel' | 'priority' | 'controllable' | 'managed' | 'budgetExempt'
>;

export type DeviceManagerParseProviders = {
    getPriority?: (deviceId: string) => number;
    getControllable?: (deviceId: string) => boolean;
    getManaged?: (deviceId: string) => boolean;
    getBudgetExempt?: (deviceId: string) => boolean;
    getCommunicationModel?: (deviceId: string) => 'local' | 'cloud';
    getDeviceDriverIdOverride?: (deviceId: string) => string | undefined;
    getExperimentalEvSupportEnabled?: () => boolean;
    getNativeEvWiringEnabled?: (deviceId: string) => boolean;
    getFlowReportedCapabilities?: (deviceId: string) => FlowReportedCapabilitiesForDevice;
};

export type DeviceManagerParseDeps = {
    logger: Logger;
    providers: DeviceManagerParseProviders;
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

export function parseDeviceList(params: {
    list: HomeyDeviceLike[];
    livePowerWByDeviceId?: LiveDevicePowerWatts;
    deps: DeviceManagerParseDeps;
}): TargetDeviceSnapshot[] {
    const { list, livePowerWByDeviceId = {}, deps } = params;
    const now = Date.now();
    return list
        .map((device) => parseDevice({ device, now, livePowerWByDeviceId, deps }))
        .filter(Boolean) as TargetDeviceSnapshot[];
}

export function parseDevice(params: {
    device: HomeyDeviceLike;
    now: number;
    livePowerWByDeviceId?: LiveDevicePowerWatts;
    deps: DeviceManagerParseDeps;
}): TargetDeviceSnapshot | null {
    const {
        device,
        now,
        livePowerWByDeviceId = {},
        deps,
    } = params;
    const {
        logger,
        providers,
        powerState,
        measuredPowerResolver,
        getCapabilityObj,
        isPowerCapable,
        resolveLatestLocalWriteMs,
    } = deps;

    const deviceId = getDeviceId(device);
    const effectiveDevice = applyDeviceDriverOverride(
        device,
        providers.getDeviceDriverIdOverride?.(deviceId),
    );
    const deviceClassKey = resolveDeviceClassKey({
        device: effectiveDevice,
        experimentalEvSupportEnabled: providers.getExperimentalEvSupportEnabled?.() === true,
    });
    if (!deviceClassKey) return null;
    const deviceLabel = resolveDeviceLabel(effectiveDevice, deviceId);
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
        logDebug: (...args: unknown[]) => logger.debug(...args),
    });
    if (!capsStatus) return null;
    const {
        currentTemperature,
        measuredPower,
        powerEstimate,
    } = resolveDevicePowerState({
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
    const {
        currentOn,
        canSetControl,
    } = resolveParsedControlState({
        logger,
        deviceLabel,
        controlCapabilityId,
        controlWriteCapabilityId,
        capabilityObj,
        evCharging,
        evChargingState,
        flowBackedCapabilityIds,
        currentOn: getCurrentOn({ deviceClassKey, capabilityObj, controlCapabilityId }),
    });
    const available = getIsAvailable(effectiveDevice);
    const powerCapable = isPowerCapable(effectiveDevice, capsStatus, powerEstimate);
    if (shouldSkipFlowBackedCandidate({
        flowAugmentedDeviceType,
        flowBackedCapabilityIds,
        capabilities,
        capabilityObj,
        requiredFlowCapabilityIds,
        reportedCapabilities,
        powerCapable,
    })) {
        return null;
    }
    const lastFreshDataMs = resolveLastFreshDataMs({
        capabilityObj,
        controlCapabilityId,
        targetCaps,
        measuredPowerObservedAtMs: measuredPower.observedAtMs,
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
        currentOn,
        evCharging,
        evChargingState,
        currentTemperature,
        capabilities,
        flowBackedCapabilityIds,
        controlAdapter,
        controlWriteCapabilityId,
        controlObservationCapabilityId,
        canSetControl,
        available,
        lastFreshDataMs,
        lastLocalWriteMs: resolveLatestLocalWriteMs(deviceId),
    });
}

function applyDeviceDriverOverride(
    device: HomeyDeviceLike,
    driverIdOverride: string | undefined,
): HomeyDeviceLike {
    const driverId = normalizeDriverIdOverride(driverIdOverride);
    return driverId ? { ...device, driverId } : device;
}

function normalizeDriverIdOverride(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized || undefined;
}

function resolveTargetDeviceType(targetCaps: readonly string[]): TargetDeviceSnapshot['deviceType'] {
    return targetCaps.length > 0 ? 'temperature' : 'onoff';
}

function buildParsedDeviceSnapshot(params: {
    device: HomeyDeviceLike;
    deviceId: string;
    deviceClassKey: string;
    providers: DeviceManagerParseProviders;
    targets: TargetDeviceSnapshot['targets'];
    targetCaps: readonly string[];
    controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
    powerEstimate: ReturnType<typeof estimatePower>;
    powerCapable: boolean;
    currentOn: boolean;
    evCharging: TargetDeviceSnapshot['evCharging'];
    evChargingState: TargetDeviceSnapshot['evChargingState'];
    currentTemperature: TargetDeviceSnapshot['currentTemperature'];
    capabilities: string[];
    flowBackedCapabilityIds: FlowReportedCapabilityId[];
    controlAdapter?: TargetDeviceSnapshot['controlAdapter'];
    controlWriteCapabilityId?: string;
    controlObservationCapabilityId?: string;
    canSetControl: boolean | undefined;
    available: boolean;
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
        currentTemperature,
        capabilities,
        flowBackedCapabilityIds,
        controlAdapter,
        controlWriteCapabilityId,
        controlObservationCapabilityId,
        canSetControl,
        available,
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
        controlCapabilityId,
        powerKw: powerEstimate.powerKw,
        expectedPowerKw: powerEstimate.expectedPowerKw,
        expectedPowerSource: powerEstimate.expectedPowerSource,
        loadKw: powerEstimate.loadKw,
        powerCapable,
        currentOn,
        evCharging,
        evChargingState,
        currentTemperature,
        measuredPowerKw: powerEstimate.measuredPowerKw,
        zone: resolveZoneLabel(device),
        capabilities,
        controlAdapter,
        controlWriteCapabilityId,
        controlObservationCapabilityId,
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
    providers: DeviceManagerParseProviders,
): ParsedDeviceSettings {
    return {
        communicationModel: providers.getCommunicationModel?.(deviceId) ?? 'local',
        priority: providers.getPriority?.(deviceId),
        controllable: providers.getControllable?.(deviceId),
        managed: providers.getManaged?.(deviceId),
        budgetExempt: providers.getBudgetExempt?.(deviceId),
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
