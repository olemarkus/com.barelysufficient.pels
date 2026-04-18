import type { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
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
    augmentCapabilitiesWithFlowReports,
    type FlowReportedCapabilityId,
    getFlowRequiredCapabilitiesForType,
    hasAllFlowReportedCapabilities,
    resolveFlowAugmentedDeviceType,
    type FlowReportedCapabilitiesForDevice,
} from './flowReportedCapabilities';
import {
    getCanSetControl,
    getControlCapabilityId,
    getCurrentOn,
    getEvChargingState,
    type DeviceCapabilityMap,
} from './deviceManagerControl';
import {
    buildTargets,
    getCapabilityValueByPrefix,
    getCurrentTemperature,
    resolveDeviceCapabilities,
} from './deviceManagerParse';
import {
    hasPotentialHomeyEnergyEstimate,
    resolvePreferredPowerRaw,
    type LiveDevicePowerWatts,
} from './deviceManagerEnergy';
import { applyMeasurementUpdates, updateLastKnownPower } from './deviceManagerRuntime';

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
    getExperimentalEvSupportEnabled?: () => boolean;
    getFlowReportedCapabilities?: (deviceId: string) => FlowReportedCapabilitiesForDevice;
};

export type DeviceManagerParseDeps = {
    logger: Logger;
    providers: DeviceManagerParseProviders;
    powerState: Required<PowerEstimateState>;
    minSignificantPowerW: number;
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
        minSignificantPowerW,
        getCapabilityObj,
        isPowerCapable,
        resolveLatestLocalWriteMs,
    } = deps;

    const deviceId = getDeviceId(device);
    const deviceClassKey = resolveDeviceClassKey({
        device,
        experimentalEvSupportEnabled: providers.getExperimentalEvSupportEnabled?.() === true,
    });
    if (!deviceClassKey) return null;
    const deviceLabel = resolveDeviceLabel(device, deviceId);
    const rawCapabilities = getCapabilities(device);
    const rawCapabilityObj = getCapabilityObj(device);
    const {
        capabilities,
        capabilityObj,
        flowAugmentedDeviceType,
        flowBackedCapabilityIds,
        reportedCapabilities,
        requiredFlowCapabilityIds,
    } = resolveFlowCapabilityOverlay({
        deviceClassKey,
        deviceId,
        rawCapabilities,
        rawCapabilityObj,
        providers,
    });
    const capsStatus = resolveDeviceCapabilities({
        deviceClassKey,
        deviceId,
        deviceLabel,
        capabilities,
        logDebug: (...args: unknown[]) => logger.debug(...args),
    });
    if (!capsStatus) return null;
    const currentTemperature = getCurrentTemperature(capabilityObj);
    const powerRaw = getCapabilityValueByPrefix(capabilities, capabilityObj, 'measure_power');
    const meterPowerRaw = getCapabilityValueByPrefix(capabilities, capabilityObj, 'meter_power');
    const livePowerRaw = livePowerWByDeviceId[deviceId];
    const preferredPowerRaw = resolvePreferredPowerRaw({ powerRaw, meterPowerRaw, livePowerRaw });
    const powerEstimate = estimatePower({
        device,
        deviceId,
        deviceLabel,
        powerRaw: preferredPowerRaw,
        meterPowerRaw,
        now,
        state: powerState,
        logger,
        minSignificantPowerW,
        updateLastKnownPower: (id, kw, label) => updateLastKnownPower({
            state: powerState,
            logger,
            deviceId: id,
            measuredKw: kw,
            deviceLabel: label,
        }),
        applyMeasurementUpdates: (id, updates, label) => applyMeasurementUpdates({
            state: powerState,
            logger,
            deviceId: id,
            updates,
            deviceLabel: label,
        }),
    });
    const targetCaps = capsStatus.targetCaps;
    const targets = buildTargets({
        targetCaps,
        capabilityObj,
        deviceLabel,
        logDebug: (...args: unknown[]) => logger.debug(...args),
    });
    const controlCapabilityId = getControlCapabilityId({ deviceClassKey, capabilities });
    const evChargingState = getEvChargingState(capabilityObj);
    const currentOn = resolveSnapshotCurrentOn({
        logger,
        deviceLabel,
        controlCapabilityId,
        capabilityObj,
        evChargingState,
        currentOn: getCurrentOn({ deviceClassKey, capabilityObj, controlCapabilityId }),
    });
    const canSetControl = getCanSetControl(controlCapabilityId, capabilityObj);
    const available = getIsAvailable(device);
    const powerCapable = isPowerCapable(device, capsStatus, powerEstimate);
    if (shouldSkipFlowBackedCandidate({
        flowAugmentedDeviceType,
        flowBackedCapabilityIds,
        reportedCapabilities,
        requiredFlowCapabilityIds,
        powerCapable,
    })) {
        return null;
    }
    const lastFreshDataMs = getTrackedCapabilityLastUpdatedMs(capabilityObj, [
        ...(controlCapabilityId ? [controlCapabilityId] : []),
        ...targetCaps,
        'measure_power',
        'measure_temperature',
        'evcharger_charging_state',
    ]);
    return buildParsedDeviceSnapshot({
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
        evChargingState,
        currentTemperature,
        capabilities,
        flowBackedCapabilityIds,
        canSetControl,
        available,
        lastFreshDataMs,
        lastLocalWriteMs: resolveLatestLocalWriteMs(deviceId),
    });
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
    evChargingState: TargetDeviceSnapshot['evChargingState'];
    currentTemperature: TargetDeviceSnapshot['currentTemperature'];
    capabilities: string[];
    flowBackedCapabilityIds: FlowReportedCapabilityId[];
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
        evChargingState,
        currentTemperature,
        capabilities,
        flowBackedCapabilityIds,
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
        evChargingState,
        currentTemperature,
        measuredPowerKw: powerEstimate.measuredPowerKw,
        zone: resolveZoneLabel(device),
        capabilities,
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

function resolveFlowCapabilityOverlay(params: {
    deviceClassKey: string;
    deviceId: string;
    rawCapabilities: string[];
    rawCapabilityObj: DeviceCapabilityMap;
    providers: DeviceManagerParseProviders;
}): {
    capabilities: string[];
    capabilityObj: DeviceCapabilityMap;
    flowAugmentedDeviceType: ReturnType<typeof resolveFlowAugmentedDeviceType>;
    flowBackedCapabilityIds: FlowReportedCapabilityId[];
    reportedCapabilities: FlowReportedCapabilitiesForDevice;
    requiredFlowCapabilityIds: readonly FlowReportedCapabilityId[];
} {
    const {
        deviceClassKey,
        deviceId,
        rawCapabilities,
        rawCapabilityObj,
        providers,
    } = params;
    const targetCapabilityIds = rawCapabilities.filter((capabilityId) => capabilityId.startsWith('target_temperature'));
    const flowAugmentedDeviceType = resolveFlowAugmentedDeviceType({
        deviceClassKey,
        targetCapabilityIds,
    });
    const requiredFlowCapabilityIds = getFlowRequiredCapabilitiesForType(flowAugmentedDeviceType);
    const reportedCapabilities = providers.getFlowReportedCapabilities?.(deviceId) ?? {};
    const {
        capabilities,
        capabilityObj,
        flowBackedCapabilityIds,
    } = augmentCapabilitiesWithFlowReports({
        deviceType: flowAugmentedDeviceType,
        capabilities: rawCapabilities,
        capabilityObj: rawCapabilityObj,
        reportedCapabilities,
    });

    return {
        capabilities,
        capabilityObj,
        flowAugmentedDeviceType,
        flowBackedCapabilityIds,
        reportedCapabilities,
        requiredFlowCapabilityIds,
    };
}

function shouldSkipFlowBackedCandidate(params: {
    flowAugmentedDeviceType: ReturnType<typeof resolveFlowAugmentedDeviceType>;
    flowBackedCapabilityIds: FlowReportedCapabilityId[];
    reportedCapabilities: FlowReportedCapabilitiesForDevice;
    requiredFlowCapabilityIds: readonly FlowReportedCapabilityId[];
    powerCapable: boolean;
}): boolean {
    const {
        flowAugmentedDeviceType,
        flowBackedCapabilityIds,
        reportedCapabilities,
        requiredFlowCapabilityIds,
        powerCapable,
    } = params;
    if (flowAugmentedDeviceType === 'unsupported') return false;

    const hasIncompleteFlowSupport = flowBackedCapabilityIds.length > 0
        && !hasAllFlowReportedCapabilities({
            reportedCapabilities,
            requiredCapabilityIds: requiredFlowCapabilityIds,
        });
    const isMissingDirectPowerSupport = flowBackedCapabilityIds.length === 0 && powerCapable === false;
    return hasIncompleteFlowSupport || isMissingDirectPowerSupport;
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

function resolveSnapshotCurrentOn(params: {
    logger: Logger;
    deviceLabel: string;
    controlCapabilityId?: TargetDeviceSnapshot['controlCapabilityId'];
    capabilityObj: DeviceCapabilityMap;
    evChargingState: TargetDeviceSnapshot['evChargingState'];
    currentOn: boolean;
}): boolean {
    const {
        logger,
        deviceLabel,
        controlCapabilityId,
        capabilityObj,
        evChargingState,
        currentOn,
    } = params;
    if (controlCapabilityId === 'onoff' && typeof capabilityObj.onoff?.value !== 'boolean') {
        logger.debug(
            `Snapshot missing boolean onoff value for ${deviceLabel}; assuming device is on`,
            capabilityObj.onoff?.value,
        );
    } else if (controlCapabilityId === 'evcharger_charging'
        && typeof capabilityObj.evcharger_charging?.value !== 'boolean'
        && evChargingState === undefined) {
        logger.debug(
            `Snapshot missing EV charging state for ${deviceLabel}; assuming device is on`,
        );
    }
    return currentOn;
}

function getTrackedCapabilityLastUpdatedMs(
    capabilityObj: DeviceCapabilityMap,
    trackedIds: readonly string[],
): number | undefined {
    let latest = 0;
    for (const id of trackedIds) {
        const rawValue = capabilityObj[id]?.lastUpdated;
        let parsed: number | undefined;
        if (rawValue instanceof Date) parsed = rawValue.getTime();
        else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) parsed = rawValue;
        else if (typeof rawValue === 'string') {
            const nextParsed = Date.parse(rawValue);
            if (Number.isFinite(nextParsed)) parsed = nextParsed;
        }
        if (parsed !== undefined) latest = Math.max(latest, parsed);
    }
    return latest > 0 ? latest : undefined;
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
