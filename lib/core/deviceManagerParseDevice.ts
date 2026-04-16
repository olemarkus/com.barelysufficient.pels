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
    const capabilities = getCapabilities(device);
    const capsStatus = resolveDeviceCapabilities({
        deviceClassKey,
        deviceId,
        deviceLabel,
        capabilities,
        logDebug: (...args: unknown[]) => logger.debug(...args),
    });
    if (!capsStatus) return null;
    const capabilityObj = getCapabilityObj(device);
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
    const { targetCaps } = capsStatus;
    const targets = buildTargets(targetCaps, capabilityObj);
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
    const deviceType = resolveTargetDeviceType(targetCaps);
    const powerCapable = isPowerCapable(device, capsStatus, powerEstimate);
    const lastFreshDataMs = getTrackedCapabilityLastUpdatedMs(capabilityObj, [
        ...(controlCapabilityId ? [controlCapabilityId] : []),
        ...targetCaps,
        'measure_power',
        'measure_temperature',
        'evcharger_charging_state',
    ]);
    const deviceSettings = resolveParsedDeviceSettings(deviceId, providers);

    return {
        id: deviceId,
        name: device.name,
        targets,
        deviceClass: deviceClassKey,
        deviceType,
        ...deviceSettings,
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
        canSetControl,
        available,
        lastFreshDataMs,
        lastLocalWriteMs: resolveLatestLocalWriteMs(deviceId),
        lastUpdated: lastFreshDataMs,
    };
}

function resolveTargetDeviceType(targetCaps: readonly unknown[]): TargetDeviceSnapshot['deviceType'] {
    return targetCaps.length > 0 ? 'temperature' : 'onoff';
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
