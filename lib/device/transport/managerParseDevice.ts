import type {
  DeviceControlProfile,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import { getDeviceId } from './managerHelpers';
import { estimatePower, type PowerEstimateState } from '../devicePowerEstimate';
import { type FlowReportedCapabilitiesForDevice } from './flowReportedCapabilities';
import { type DeviceCapabilityMap } from '../managerControl';
import { resolveDeviceCapabilities } from './managerParse';
import {
    hasPotentialHomeyEnergyEstimate,
    type LiveDevicePowerWatts,
} from '../managerEnergy';
import type { DeviceMeasuredPowerResolver } from '../measuredPowerResolver';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { resolveParseDeviceIdentity } from './managerParseIdentity';
import {
    resolveManagedFilterDecision,
    shouldDropEarly,
} from './managerManagedFilter';
import {
    assembleDeviceSnapshot,
    resolveDeviceCapabilityProfile,
} from './managerParseDeviceFields';

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
    getDeviceTargetPowerConfig?: (deviceId: string) => TargetPowerSteppedLoadConfig | undefined;
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
    previousSnapshotById?: ReadonlyMap<string, TransportDeviceSnapshot>;
    deps: DeviceTransportParseDeps;
    purpose?: ParseDevicePurpose;
}): TransportDeviceSnapshot[] {
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
        .filter(Boolean) as TransportDeviceSnapshot[];
}

export function parseDevice(params: {
    device: HomeyDeviceLike;
    now: number;
    livePowerWByDeviceId?: LiveDevicePowerWatts;
    previousSnapshot?: TransportDeviceSnapshot;
    deps: DeviceTransportParseDeps;
    purpose?: ParseDevicePurpose;
}): TransportDeviceSnapshot | null {
    const { device, now, livePowerWByDeviceId = {}, previousSnapshot, deps, purpose = 'runtime' } = params;
    const identity = resolveParseDeviceIdentity({ device });
    if (!identity) return null;
    const managedDecision = resolveManagedFilterDecision({
        providers: deps.providers, deviceId: identity.deviceId,
    });
    if (shouldDropEarly({ purpose, decision: managedDecision })) return null;
    const profile = resolveDeviceCapabilityProfile({ identity, deps });
    if (!profile) return null;
    return assembleDeviceSnapshot({
        identity,
        deps,
        overlay: profile.overlay,
        capsStatus: profile.capsStatus,
        now,
        livePowerWByDeviceId,
        previousSnapshot,
        purpose,
        managedDecision,
    });
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
