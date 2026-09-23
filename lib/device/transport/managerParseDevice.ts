import type { RetainedPowerReading } from '../retainedPowerStore';
import type {
  DeviceControlProfile,
  MeteredPowerReading,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../../packages/contracts/src/types';
import type { MainMeterSelection } from '../../../packages/contracts/src/mainMeterSelection';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
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
 * Can PELS support this device at all? A STRUCTURAL question about the device's
 * capabilities and configuration, and deliberately NOT about whether it happens
 * to be reporting a number this cycle.
 *
 * This is the flag that reaches persisted settings. `disableUnsupportedDevices`
 * (`setup/appDeviceSupport.ts`) demotes `managed` / `controllable` /
 * `price_optimization_settings` to `false` for a `powerCapable: false` device,
 * and nothing in the runtime ever writes them back to `true` — the owner has to
 * re-enable the device by hand. So this predicate must only go false for a
 * durable fact about the device, never for a transient read.
 *
 * That is why it must stay structural. Making it a LIVE reading check turned one
 * missing reading into a permanent demotion: a home battery
 * reads NEGATIVE `measure_power` while discharging, the resolver drops a negative
 * as "not a draw", and an observe-only device stays in the snapshot (it is
 * force-managed by design, `managerManagedFilter.ts`) — so it reached the demotion
 * path and was permanently unmanaged on its first discharge. Ordinary devices were
 * spared only incidentally, by dropping out of the snapshot first. The live
 * question — what is this device drawing right now — is not asked here at all;
 * the producer answers it, from the meter.
 *
 * `powerEstimate.loadKw` is deliberately NOT a term, and reading the code as if
 * it were is an easy mistake to make — so, the provenance the code never
 * recorded: `settings.load` was added for ELKO devices specifically, and it was
 * never meant to be an eligibility source on its own. Its job is to refine the
 * expected-power ESTIMATE (`expectedPowerSource: 'load-setting'`), which it still
 * does. Those Elko devices report through plain `measure_power` and `meter_power`
 * — confirmed against real hardware (`no.elko:smart_plus_thermostat`) and across
 * a whole fleet — so `capsStatus.hasPower` admits them and dropping the term
 * demoted nothing.
 *
 * Homey Energy metadata and the owner's Energy settings ("Energy used when
 * on") are structural support signals, not readings. They keep the owner's
 * managed and price choices for the device. Admission to power limiting is a
 * different question with a different answer: it takes a real per-device power
 * reading, and the plan projection only gives a device a power axis when it has
 * one (`isMeteredPlanDevice`). A device with neither a power capability nor
 * Energy metadata or settings is unsupported.
 *
 * A device with no power capability and no Energy metadata or settings can
 * still be supported by what Homey Energy reports for it: its live value is a
 * real reading of that device, and once seen it is retained with the snapshot.
 * Those two terms depend on the reading reaching the transport. The retained
 * one survives a restart (`retainedPowerPersistence.ts`), so the first read
 * after boot — which has no previous snapshot and, on the fast boot refresh, no
 * live report — still answers as the last run did.
 *
 * See `notes/persisted-settings-state.md`: transient external failures get a grace
 * window, never a destructive reset of persisted state.
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
