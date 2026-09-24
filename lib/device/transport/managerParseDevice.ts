import type { RetainedPowerReading } from '../retainedPowerStore';
import type {
  DeviceControlProfile,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../../packages/contracts/src/types';
import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';
import type { MeteredPowerReading, TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import { getDeviceId } from './managerHelpers';
import type { ResolvedTransportPowerState } from './transportTypes';
import { type FlowReportedCapabilitiesForDevice } from './flowReportedCapabilities';
import { type DeviceCapabilityMap } from '../managerControl';
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
};

export type DeviceTransportParseProviders = {
    /**
     * Producer-resolved Main selection. REQUIRED: the transport's live-power
     * paths may not invent an authority, and `unavailable` is a real answer a
     * wired producer gives — never a default anything falls back to. Read it
     * through `ctx.resolveMainMeterSelection`, never directly.
     */
    getHomeyEnergyMeterSelection: () => MainMeterSelection;
    /**
     * Additional per-meter reading requests for the SAME `manager/energy/live`
     * payload (multi-home R7b: each sub-home's own meter device). Read fresh
     * per poll so a homes-config change needs no transport restart. Empty /
     * absent = no extra extraction — the single-home path is untouched.
     */
    getAdditionalMeterDeviceIds?: () => readonly string[];
    /**
     * Push seam for the readings the request above resolved (multi-home R7b):
     * `pollHomePowerWithMeterFanOut` hands each poll's finite per-meter map to
     * this consumer (the home-runtime registry routes them to per-home
     * pipelines). A provider closure rather than a transport setter so the
     * wiring stays lazy — reads through it no-op until (and after) the
     * registry exists.
     */
    onAdditionalMeterReadings?: (readings: Record<string, number>, nowMs: number) => void;
    getControllable?: (deviceId: string) => boolean;
    getManaged?: (deviceId: string) => boolean;
    isManagedFilterActive?: () => boolean;
    getBudgetExempt?: (deviceId: string) => boolean;
    getDeviceDriverIdOverride?: (deviceId: string) => string | undefined;
    getNativeEvWiringEnabled?: (deviceId: string) => boolean;
    getFlowConflict?: (deviceId: string) => TargetDeviceSnapshot['flowConflict'];
    getDeviceControlProfile?: (deviceId: string) => DeviceControlProfile | undefined;
    getDeviceTargetPowerConfig?: (deviceId: string) => TargetPowerSteppedLoadConfig | undefined;
    getFlowReportedCapabilities?: (deviceId: string) => FlowReportedCapabilitiesForDevice;
    /**
     * The cars the user ticked for this charger — an eligibility set, not an
     * association. Empty or absent means the feature is off for the charger.
     *
     * A plain predicate rather than a settings read: `lib/device` may not reach
     * settings or `AppContext` (`no-domain-to-app-layer`), so the app layer
     * resolves the value and hands it in, as it does for `getBudgetExempt`.
     */
    getEvCarAssociationCarIds?: (chargerId: string) => readonly string[];
};

export type DeviceTransportParseDeps = {
    logger: Logger;
    debugStructured?: StructuredDebugEmitter;
    providers: DeviceTransportParseProviders;
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

/**
 * Does this read contain evidence that the device can expose power? Evidence may
 * be structural (capability or Homey Energy metadata), live (a Homey Energy
 * report), or retained from an earlier reading. Because live evidence can be
 * missing on a fast boot refresh, `false` is not durable proof of unsupported
 * hardware and must not overwrite saved owner choices. Plan admission asks the
 * separate, stricter question: is a trusted per-device reading available now?
 *
 * Homey Energy metadata and the owner's Energy settings ("Energy used when
 * on") are support signals, not readings. Admission to any plan control takes a
 * real per-device power reading, and the plan projection only gives a device a
 * power axis when it has one (`isMeteredPlanDevice`).
 *
 * A device without structural support may still expose a real reading through
 * the Homey Energy live report. The reading and its retained copy make the
 * device usable after the transport receives it; until then the absence is an
 * unresolved input and leaves saved owner choices untouched.
 */
export function isDevicePowerCapable(params: {
    device: HomeyDeviceLike;
    capsStatus: { hasPower: boolean };
    measuredPower: { measuredPowerKw?: number };
    retainedReading: RetainedMeasurement | undefined;
}): boolean {
    const { device, capsStatus, measuredPower, retainedReading } = params;
    return capsStatus.hasPower
        || hasPotentialHomeyEnergyEstimate(device)
        || typeof measuredPower.measuredPowerKw === 'number'
        || retainedReading !== undefined;
}
