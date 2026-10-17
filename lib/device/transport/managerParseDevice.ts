import type { RetainedPowerReading } from '../retainedPowerStore';
import type { DeviceControlSettings } from '../deviceControlSettings';
import type { FlowBackedDeviceState } from '../flowBackedDeviceState';
import type { DeviceManagement } from '../deviceRoleReads';
import type {
  TargetDeviceSnapshot,
} from '../../../packages/contracts/src/types';
import type { MeasuredPowerSource, MeteredPowerReading, TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import { getDeviceId } from './managerHelpers';
import type { ResolvedTransportPowerState } from './transportTypes';
import { type DeviceCapabilityMap } from '../managerControl';
import {
    hasPotentialHomeyEnergyEstimate,
    type LiveDevicePowerWatts,
} from '../managerEnergy';
import type { DeviceMeasuredPowerResolver } from '../measuredPowerResolver';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { resolveParseDeviceIdentity } from './managerParseIdentity';
import { isHomeBatteryDevice } from '../managerEnergy';
export { applyDeviceDriverOverride } from './managerParseIdentity';
import {
    resolveManagedFilterDecision,
    shouldDropEarly,
} from './managerManagedFilter';
import {
    assembleDeviceSnapshot,
    resolveDeviceCapabilityProfile,
} from './managerParseDeviceFields';

/**
 * The power reading a parse carries forward for a device that reports none this
 * read: the previous snapshot's (which keeps its delivery-interval record,
 * already booked this run) or, on the first read after a restart, the one the
 * retained-power store restored (which has none). Dated when the entry it came
 * from was.
 */
export type RetainedMeasurement = {
    measuredPowerKw: number;
    observedAtMs?: number;
    reading?: MeteredPowerReading;
    source?: MeasuredPowerSource;
};

/**
 * The owner's per-device configuration a parse reads. `DeviceControlSettings`
 * is the one producer; specs stub the members they are about.
 */
export type DeviceParseSettings = Pick<
    DeviceControlSettings,
    | 'isManaged'
    | 'isControllable'
    | 'isManagedFilterActive'
    | 'isBudgetExempt'
    | 'getDeviceDriverIdOverride'
    | 'getDeviceControlProfile'
    | 'getDeviceTargetPowerConfig'
    | 'getEvCarAssociationCarIds'
>;

/**
 * Whether native wiring is on for a device, and any Flow conflict found for it.
 * Answered today by `AppNativeWiring` in `setup/`, which still owns the decision.
 */
export type NativeWiringRead = {
    /** The user's explicit choice, else the conflict-gated automatic decision. */
    resolveNativeWiringEnabled(deviceId: string): boolean;
    getFlowConflict(deviceId: string): TargetDeviceSnapshot['flowConflict'];
};

/**
 * The Flow-backed device state the transport reads and writes: the capability
 * values Flow cards reported, and the learned peaks it persists when a reading
 * moves one (`FlowBackedDeviceState`).
 */
export type FlowBackedRead = Pick<
    FlowBackedDeviceState,
    'getFlowReportedCapabilitiesForDevice' | 'persistLearnedPeaks'
>;

export type DeviceTransportParseDeps = {
    logger: Logger;
    debugStructured?: StructuredDebugEmitter;
    settings: DeviceParseSettings;
    nativeWiring: NativeWiringRead;
    flowBacked: FlowBackedRead;
    management: DeviceManagement;
    powerState: ResolvedTransportPowerState;
    measuredPowerResolver: DeviceMeasuredPowerResolver;
    getCapabilityObj: (device: HomeyDeviceLike) => DeviceCapabilityMap;
    isPowerCapable: (
        device: HomeyDeviceLike,
        capsStatus: { hasPower: boolean },
        measuredPower: { measuredPowerKw?: number },
        retainedReading: RetainedMeasurement | undefined,
    ) => boolean;
    /** The reading the retained-power store restored for a device (`retainedPowerPersistence.ts`). */
    getRestoredPowerReading: (deviceId: string) => RetainedPowerReading | undefined;
    resolveLatestLocalWriteMs: (deviceId: string) => number | undefined;
};

/**
 * The owners a parse asks about a device: its configuration, native wiring,
 * Flow reports, and whether it is managed and under Power-limit control. The transport holds
 * them for the reader that builds each parse's dependencies.
 */
export type DeviceParseSources = Pick<
    DeviceTransportParseDeps,
    'settings' | 'nativeWiring' | 'flowBacked' | 'management'
>;

export type ParseDevicePurpose = 'runtime' | 'ui_picker';

export function parseDeviceList(
    list: HomeyDeviceLike[],
    livePowerWByDeviceId: LiveDevicePowerWatts,
    previousSnapshotById: ReadonlyMap<string, TransportDeviceSnapshot>,
    deps: DeviceTransportParseDeps,
    purpose: ParseDevicePurpose,
): TransportDeviceSnapshot[] {
    const now = Date.now();
    return list
        .map((device) => parseDevice(
            device,
            now,
            livePowerWByDeviceId,
            previousSnapshotById.get(getDeviceId(device)),
            deps,
            purpose,
        ))
        .filter(Boolean) as TransportDeviceSnapshot[];
}

export function parseDevice(
    device: HomeyDeviceLike,
    now: number,
    livePowerWByDeviceId: LiveDevicePowerWatts,
    previousSnapshot: TransportDeviceSnapshot | undefined,
    deps: DeviceTransportParseDeps,
    purpose: ParseDevicePurpose,
): TransportDeviceSnapshot | null {
    const identity = resolveParseDeviceIdentity({ device });
    if (!identity) return null;
    const managedDecision = resolveManagedFilterDecision(deps.management, identity.deviceId);
    if (shouldDropEarly(purpose, managedDecision, isHomeBatteryDevice(device))) return null;
    const profile = resolveDeviceCapabilityProfile(identity, deps);
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

/**
 * Does this read contain evidence that the device can expose power? Evidence may
 * be structural (capability or Homey Energy metadata), live (a Homey Energy
 * report), or retained from an earlier reading. Because live evidence can be
 * missing on a fast boot refresh, `false` is not durable proof of unsupported
 * hardware and must not overwrite saved owner choices. Power limiting asks the
 * separate, stricter question: is a trusted per-device reading available now?
 *
 * Homey Energy metadata and the owner's Energy settings ("Energy used when
 * on") are support signals, not readings. Power limiting and command authority
 * take a real per-device power reading, and the plan projection only gives a
 * device a power axis when it has one (`isMeteredPlanDevice`). A temperature
 * device without one is still planned for its mode target and price shift.
 *
 * A device without structural support may still expose a real reading through
 * the Homey Energy live report. The reading and its retained copy make the
 * device usable after the transport receives it; until then the absence is an
 * unresolved input and leaves saved owner choices untouched.
 */
export function isDevicePowerCapable(
    device: HomeyDeviceLike,
    capsStatus: { hasPower: boolean },
    measuredPower: { measuredPowerKw?: number },
    retainedReading: RetainedMeasurement | undefined,
): boolean {
    return capsStatus.hasPower
        || hasPotentialHomeyEnergyEstimate(device)
        || typeof measuredPower.measuredPowerKw === 'number'
        || retainedReading !== undefined;
}
