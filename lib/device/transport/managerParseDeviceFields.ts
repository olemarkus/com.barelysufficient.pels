import type { RetainedPowerReading } from '../retainedPowerStore';
import { hasObservedMeasuredPower } from '../../../packages/shared-domain/src/measuredPowerObservedState';
import type {
  DeviceStateOfChargeSnapshot,
  EvChargingState,
  MeteredPowerReading,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import {
    isReportedThermostatMode,
    normalizeReportedThermostatMode,
    THERMOSTAT_MODE_CAPABILITY_ID,
} from './thermostatModeRealtime';
import type { HomeyDeviceLike } from '../../utils/types';
import {
    getCapabilities,
    resolveZoneId,
    resolveZoneLabel,
} from './managerHelpers';
import { estimatePower } from '../devicePowerEstimate';
import {
    type FlowReportedCapabilityId,
    type FlowReportedCapabilitiesForDevice,
} from './flowReportedCapabilities';
import {
  getControlCapabilityId,
  getEvCharging,
  getEvChargingState,
  toCapabilityTimestampMs,
  type DeviceCapabilityMap,
} from '../managerControl';
import {
    buildTargets,
    resolveDeviceCapabilities,
} from './managerParse';
import {
    hasPotentialHomeyEnergyEstimate,
    isObserveOnlyRoleDevice,
    type LiveDevicePowerWatts,
} from '../managerEnergy';
import { resolveMeasuredPowerKw } from '../managerMeasuredPower';
import {
    resolveCandidateCapabilities,
    resolveFlowCapabilityOverlay,
} from '../managerNativeEv';
import { shouldSkipFlowBackedCandidate } from '../managerFlowSupport';
import {
    resolveBinaryControlObservation,
} from './managerParseSnapshot';
import {
    resolveStateOfChargeSnapshot,
    } from './stateOfCharge';
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
import { resolveDevicePowerState } from './managerParsePowerState';
import { resolveParsedLastFreshDataMs } from './managerParseFreshness';
import {
    resolveTargetDeviceType,
    resolveTemperatureObservation,
} from './temperatureObservation';

type ParsedDeviceSettings = Pick<
    TargetDeviceSnapshot,
    'priority' | 'controllable' | 'managed' | 'budgetExempt' | 'flowConflict'
>;

type DeviceCapabilityProfile = {
    overlay: ReturnType<typeof resolveFlowCapabilityOverlay>;
    capsStatus: NonNullable<ReturnType<typeof resolveDeviceCapabilities>>;
};

type DeviceControlBundle = {
    binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
    hasObservedBinaryControl: boolean;
    evCharging: TargetDeviceSnapshot['evCharging'];
    evChargingState: EvChargingState | undefined;
    binaryControl: TargetDeviceSnapshot['binaryControl'];
    canSetControl: boolean | undefined;
    available: boolean;
    powerCapable: boolean;
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

/**
 * The device's raw reported `thermostat_mode`.
 *
 * Reported, not interpreted: the vocabulary that turns this into a direction is
 * the observer's (`resolveThermalDirection`). A read that reaches the parse
 * conformed to the device-read contract (`deviceReadContract.ts`), so a declared
 * mode came with a string value; nothing is carried over from the previous
 * entry. A blank string is no mode at all.
 */
function readReportedThermostatMode(overlay: DeviceCapabilityProfile['overlay']): string | undefined {
    if (!overlay.capabilities.includes(THERMOSTAT_MODE_CAPABILITY_ID)) return undefined;
    const value = overlay.capabilityObj[THERMOSTAT_MODE_CAPABILITY_ID]?.value;
    return isReportedThermostatMode(value) ? normalizeReportedThermostatMode(value) : undefined;
}

/**
 * The last trusted reading this read can fall back on: the previous snapshot's,
 * or — when the transport has no previous entry for the device, which after a
 * restart is every device on the first read — the one the retained-power store
 * restored (`retainedPowerPersistence.ts`). A device that already has an entry
 * this run and no reading in it has nothing retained; the store is not asked.
 */
// What a parse carries forward: the previous snapshot's reading keeps its
// delivery-interval record (already booked this run); a restored one has none.
type RetainedMeasurement = RetainedPowerReading & { reading?: MeteredPowerReading };

function resolveRetainedReading(
    previousSnapshot: TransportDeviceSnapshot | undefined,
    restored: RetainedPowerReading | undefined,
): RetainedMeasurement | undefined {
    if (previousSnapshot === undefined) return restored;
    if (!hasObservedMeasuredPower(previousSnapshot)) return undefined;
    return {
        measuredPowerKw: previousSnapshot.measuredPowerKw,
        ...(previousSnapshot.measuredPowerObservedAtMs !== undefined
            ? { observedAtMs: previousSnapshot.measuredPowerObservedAtMs } : {}),
        ...(previousSnapshot.measuredPowerReading !== undefined
            ? { reading: previousSnapshot.measuredPowerReading } : {}),
    };
}

function resolveRetainedMeasuredPower(
    device: HomeyDeviceLike,
    capsStatus: DeviceCapabilityProfile['capsStatus'],
    measuredPower: ReturnType<typeof resolveMeasuredPowerKw>,
    retained: RetainedMeasurement | undefined,
): ReturnType<typeof resolveMeasuredPowerKw> {
    if (measuredPower.measuredPowerKw !== undefined) return measuredPower;
    if (!capsStatus.hasPower && !hasPotentialHomeyEnergyEstimate(device)) return measuredPower;
    if (retained === undefined) return measuredPower;
    return {
        measuredPowerKw: retained.measuredPowerKw,
        observedAtMs: retained.observedAtMs,
        reading: retained.reading,
    };
}

function resolveDeviceControlBundle(params: {
    identity: ParsedDeviceIdentity;
    deps: DeviceTransportParseDeps;
    overlay: DeviceCapabilityProfile['overlay'];
    capsStatus: DeviceCapabilityProfile['capsStatus'];
    binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
    measuredPower: ReturnType<typeof resolveMeasuredPowerKw>;
    previousSnapshot?: TransportDeviceSnapshot;
    retainedReading: RetainedMeasurement | undefined;
    purpose: ParseDevicePurpose;
    managedDecision: ManagedFilterDecision;
}): DeviceControlBundle | null {
    const {
        identity, deps, overlay, capsStatus, binaryCapabilityId, measuredPower,
        previousSnapshot, retainedReading, purpose, managedDecision,
    } = params;
    const { effectiveDevice, deviceId, deviceClassKey, deviceLabel } = identity;
    const { logger, debugStructured, isPowerCapable } = deps;
    const evCharging = getEvCharging(overlay.capabilityObj);
    // A declared plug state is a member of the Homey enum by the time a read
    // reaches the parse: the read contract (`deviceReadContract.ts`) ignored any
    // read — native or converted — whose state was missing or out of the enum.
    const evChargingState = getEvChargingState(overlay.capabilityObj);
    const {
        resolvedOn, binaryControl, canSetControl, observedCurrentOn, hasTrustedControlState,
    }
        = resolveDeviceParsedControlState({
        logger,
        debugStructured, deviceId, deviceName: effectiveDevice.name ?? null,
        deviceLabel,
        deviceClassKey,
        binaryCapabilityId,
        binaryWriteCapabilityId: overlay.binaryWriteCapabilityId,
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
        binaryCapabilityId, hasTrustedControlState, overlay.steppedLoadProfile, effectiveDevice,
    );
    const powerCapable = isPowerCapable(effectiveDevice, capsStatus, measuredPower, retainedReading);
    if (shouldSkipFlowBackedCandidate({
        flowAugmentedDeviceType: overlay.flowAugmentedDeviceType,
        flowBackedCapabilityIds: overlay.flowBackedCapabilityIds,
        capabilities: overlay.capabilities, capabilityObj: overlay.capabilityObj,
        requiredFlowCapabilityIds: overlay.requiredFlowCapabilityIds,
        reportedCapabilities: overlay.reportedCapabilities, powerCapable,
    })) {
        return null;
    }
    return {
        binaryCapabilityId, evCharging, evChargingState, binaryControl, canSetControl,
        hasObservedBinaryControl: observedCurrentOn !== undefined, available, powerCapable,
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
    const { identity, deps, overlay, capsStatus, now, livePowerWByDeviceId,
        previousSnapshot, purpose, managedDecision } = params;
    const { effectiveDevice, deviceId, deviceClassKey, deviceLabel } = identity;
    const { providers, debugStructured, resolveLatestLocalWriteMs } = deps;
    // Resolved once here and handed to both consumers: the power estimate needs it
    // for the EV rung of its default, and the control bundle needs it for
    // everything else. It is a pure function of (deviceClassKey, capabilities), so
    // a second call could not disagree — but one call is one fewer thing to keep
    // in step.
    const binaryCapabilityId = getControlCapabilityId({
        deviceClassKey,
        capabilities: overlay.capabilities,
    });
    const { currentTemperature, measuredPower, powerEstimate } = resolveDevicePowerState({
        device: effectiveDevice,
        deviceId,
        deviceLabel,
        binaryCapabilityId,
        capabilities: overlay.capabilities,
        capabilityObj: overlay.capabilityObj,
        livePowerWByDeviceId,
        now,
        measuredPowerResolver: deps.measuredPowerResolver,
        powerState: deps.powerState,
        logger: deps.logger,
    });
    // Keep the last trusted measurement when a refresh has no newer sample.
    // In particular, re-reading one `meter_power` sample must not drop admission.
    const retainedReading = resolveRetainedReading(previousSnapshot, deps.getRestoredPowerReading(deviceId));
    const resolvedMeasuredPower = resolveRetainedMeasuredPower(
        effectiveDevice, capsStatus, measuredPower, retainedReading,
    );
    const candidateTargets = buildTargets({
        targetCaps: capsStatus.targetCaps, capabilityObj: overlay.capabilityObj, deviceId, deviceLabel,
        debugStructured,
    });
    const temperature = resolveTemperatureObservation(currentTemperature, candidateTargets);
    const thermostatMode = readReportedThermostatMode(overlay);
    const targets = temperature ? [temperature.target] : [];
    const control = resolveDeviceControlBundle({
        identity, deps, overlay, capsStatus, binaryCapabilityId,
        measuredPower: resolvedMeasuredPower,
        previousSnapshot, retainedReading, purpose, managedDecision,
    });
    if (!control) return null;
    if (
        capsStatus.targetCaps.length > 0
        && !temperature
        && !control.binaryCapabilityId
        && !overlay.steppedLoadProfile
    ) return null;
    const lastFreshDataMs = resolveParsedLastFreshDataMs({
        capabilityObj: overlay.capabilityObj,
        binaryCapabilityId: control.binaryCapabilityId,
        hasObservedBinaryControl: control.hasObservedBinaryControl,
        evChargingState: control.evChargingState,
        hasTemperature: temperature !== undefined,
        reportedStepObservedAtMs: overlay.reportedStepObservedAtMs,
        measuredPowerObservedAtMs: measuredPower.observedAtMs,
    });
    return buildParsedDeviceSnapshot({
        device: effectiveDevice,
        deviceId,
        deviceClassKey,
        providers,
        targets,
        temperature,
        binaryCapabilityId: control.binaryCapabilityId,
        powerEstimate,
        measuredPowerKw: resolvedMeasuredPower.measuredPowerKw, measuredPowerReading: resolvedMeasuredPower.reading,
        powerCapable: control.powerCapable,
        binaryControl: control.binaryControl,
        evCharging: control.evCharging,
        evChargingObservedAtMs: toCapabilityTimestampMs(
            overlay.capabilityObj.evcharger_charging?.lastUpdated,
        ),
        evChargingState: control.evChargingState,
        evChargingStateObservedAtMs: toCapabilityTimestampMs(
            overlay.capabilityObj.evcharger_charging_state?.lastUpdated,
        ),
        thermostatMode,
        stateOfCharge: resolveParsedSoc({
            deviceClassKey,
            nowMs: now,
            capabilityObj: overlay.capabilityObj,
            reportedCapabilities: overlay.reportedCapabilities,
            retainedStateOfCharge: previousSnapshot?.stateOfCharge,
            eligibleCarIds: providers.getEvCarAssociationCarIds?.(deviceId) ?? [],
        }),
        capabilities: overlay.capabilities,
        flowBackedCapabilityIds: overlay.flowBackedCapabilityIds,
        controlAdapter: overlay.controlAdapter,
        binaryWriteCapabilityId: overlay.binaryWriteCapabilityId,
        binaryObservationCapabilityId: overlay.binaryObservationCapabilityId,
        controlModel: overlay.controlModel,
        steppedLoadProfile: overlay.steppedLoadProfile,
        nativeWriteCapabilities: overlay.nativeWriteCapabilities,
        targetPowerConfig: overlay.targetPowerConfig,
        canSetControl: control.canSetControl,
        binaryControlObservation: resolveBinaryControlObservation({
            capabilityObj: overlay.capabilityObj,
            binaryCapabilityId: control.binaryCapabilityId,
            binaryObservationCapabilityId: overlay.binaryObservationCapabilityId,
        }),
        available: control.available,
        reportedStepId: overlay.reportedStepId, reportedStepPowerW: overlay.reportedStepPowerW,
        reportedStepObservedAtMs: overlay.reportedStepObservedAtMs,
        suggestedSteppedLoadProfile: overlay.suggestedSteppedLoadProfile,
        measuredPowerObservedAtMs: resolvedMeasuredPower.observedAtMs,
        lastFreshDataMs,
        lastLocalWriteMs: resolveLatestLocalWriteMs(deviceId),
    });
}

// `retainedSession` carries the session anchor the transport already holds for
// this charger. A full refresh sees only the CURRENT plug state, never the
// plug-out that preceded it, so re-deriving the anchor from scratch would let a
// mid-session charging-state change look like a reconnect and invalidate the
// last SoC report. Same rule as "never let an older full fetch erase a fresher
// realtime observation" (`lib/device/AGENTS.md`).
function resolveParsedSoc(params: {
    deviceClassKey: string;
    nowMs: number;
    capabilityObj: DeviceCapabilityMap;
    reportedCapabilities: FlowReportedCapabilitiesForDevice;
    retainedStateOfCharge: DeviceStateOfChargeSnapshot | undefined;
    eligibleCarIds: readonly string[];
}): DeviceStateOfChargeSnapshot | undefined {
    return resolveStateOfChargeSnapshot({
        ...params,
        retainedSession: params.retainedStateOfCharge,
    });
}

function buildParsedDeviceSnapshot(params: {
    device: HomeyDeviceLike;
    deviceId: string;
    deviceClassKey: string;
    providers: DeviceTransportParseProviders;
    targets: TargetDeviceSnapshot['targets'];
    temperature: TransportDeviceSnapshot['temperature'];
    binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
    powerEstimate: ReturnType<typeof estimatePower>;
    powerCapable: boolean;
    binaryControl: TargetDeviceSnapshot['binaryControl'];
    evCharging: TargetDeviceSnapshot['evCharging'];
    evChargingObservedAtMs?: number;
    evChargingState: EvChargingState | undefined;
    evChargingStateObservedAtMs?: number;
    thermostatMode?: string;
    stateOfCharge: DeviceStateOfChargeSnapshot | undefined;
    capabilities: string[];
    flowBackedCapabilityIds: FlowReportedCapabilityId[];
    controlAdapter?: TargetDeviceSnapshot['controlAdapter'];
    binaryWriteCapabilityId?: string;
    binaryObservationCapabilityId?: string;
    controlModel?: TargetDeviceSnapshot['controlModel'];
    steppedLoadProfile?: SteppedLoadProfile;
    nativeWriteCapabilities?: TargetDeviceSnapshot['nativeWriteCapabilities'];
    targetPowerConfig?: TargetPowerSteppedLoadConfig;
    canSetControl: boolean | undefined;
    binaryControlObservation: TargetDeviceSnapshot['binaryControlObservation'];
    available: boolean;
    reportedStepId?: string; reportedStepPowerW?: number; reportedStepObservedAtMs?: number;
    suggestedSteppedLoadProfile?: TargetDeviceSnapshot['suggestedSteppedLoadProfile'];
    measuredPowerKw?: number; measuredPowerObservedAtMs?: number; measuredPowerReading?: MeteredPowerReading;
    lastFreshDataMs?: number;
    lastLocalWriteMs?: number;
}): TransportDeviceSnapshot {
    const {
        device,
        deviceId,
        deviceClassKey,
        providers,
        targets,
        temperature,
        binaryCapabilityId,
        powerEstimate,
        powerCapable,
        binaryControl,
        evCharging,
        evChargingObservedAtMs,
        evChargingState,
        evChargingStateObservedAtMs,
        stateOfCharge,
        capabilities,
        flowBackedCapabilityIds,
        controlAdapter,
        binaryWriteCapabilityId,
        binaryObservationCapabilityId,
        controlModel,
        steppedLoadProfile,
        nativeWriteCapabilities,
        targetPowerConfig,
        canSetControl,
        binaryControlObservation,
        available,
        reportedStepId, reportedStepPowerW, reportedStepObservedAtMs,
        suggestedSteppedLoadProfile,
        measuredPowerKw, measuredPowerObservedAtMs, measuredPowerReading,
        lastFreshDataMs,
        lastLocalWriteMs,
    } = params;
    return {
        id: deviceId,
        name: device.name,
        targets,
        deviceClass: deviceClassKey,
        deviceType: resolveTargetDeviceType(temperature),
        ...resolveParsedDeviceSettings(device, deviceId, providers),
        controlModel,
        binaryControllable: binaryControl !== undefined,
        deviceRole: binaryCapabilityId === 'evcharger_charging' || deviceClassKey === 'evcharger'
            ? 'ev_charger'
            : undefined,
        steppedLoadProfile,
        nativeWriteCapabilities,
        targetPowerConfig,
        binaryCapabilityId,
        expectedPowerKw: powerEstimate.expectedPowerKw,
        expectedPowerSource: powerEstimate.expectedPowerSource,
        powerCapable,
        binaryControl,
        evCharging,
        evChargingObservedAtMs,
        evChargingState,
        evChargingStateObservedAtMs,
        // Read off `params` rather than destructured with its siblings: this
        // function sits one line under the max-lines cap.
        thermostatMode: params.thermostatMode,
        stateOfCharge,
        temperature,
        measuredPowerKw, measuredPowerObservedAtMs, measuredPowerReading,
        zone: resolveZoneLabel(device),
        zoneId: resolveZoneId(device),
        capabilities,
        controlAdapter,
        binaryWriteCapabilityId,
        binaryObservationCapabilityId,
        binaryControlObservation,
        reportedStepId, reportedStepPowerW, reportedStepObservedAtMs,
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

function resolveParsedDeviceSettings(
    device: HomeyDeviceLike,
    deviceId: string,
    providers: DeviceTransportParseProviders,
): ParsedDeviceSettings {
    const base = {
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
