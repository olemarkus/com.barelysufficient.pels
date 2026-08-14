import type {
  DeviceStateOfChargeSnapshot,
  EvChargingState,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
  TargetPowerSteppedLoadConfig,
} from '../../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
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
    shouldDropForEvPlugStateContract,
} from './managerParse';
import {
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
    'communicationModel' | 'priority' | 'controllable' | 'managed' | 'budgetExempt' | 'flowConflict'
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

function resolveDeviceControlBundle(params: {
    identity: ParsedDeviceIdentity;
    deps: DeviceTransportParseDeps;
    overlay: DeviceCapabilityProfile['overlay'];
    capsStatus: DeviceCapabilityProfile['capsStatus'];
    binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
    powerEstimate: ReturnType<typeof estimatePower>;
    measuredPower: ReturnType<typeof resolveMeasuredPowerKw>;
    previousSnapshot?: TransportDeviceSnapshot;
    purpose: ParseDevicePurpose;
    managedDecision: ManagedFilterDecision;
}): DeviceControlBundle | null {
    const {
        identity, deps, overlay, capsStatus, binaryCapabilityId, powerEstimate, measuredPower,
        previousSnapshot, purpose, managedDecision,
    } = params;
    const { effectiveDevice, deviceId, deviceClassKey, deviceLabel } = identity;
    const { logger, debugStructured, isPowerCapable } = deps;
    const evCharging = getEvCharging(overlay.capabilityObj);
    const evChargingState = getEvChargingState(overlay.capabilityObj);
    if (shouldDropForEvPlugStateContract({
        deviceClassKey,
        deviceId,
        deviceLabel,
        capabilities: overlay.capabilities,
        stateReportedInPayload: overlay.capabilityObj.evcharger_charging_state !== undefined,
        reportedStateValue: overlay.capabilityObj.evcharger_charging_state?.value,
        evChargingState,
        retainedEvChargingState: previousSnapshot?.evChargingState,
        debugStructured,
    })) return null;
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
    const powerCapable = isPowerCapable(effectiveDevice, capsStatus, measuredPower, powerEstimate);
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
    const {
        identity, deps, overlay, capsStatus, now, livePowerWByDeviceId,
        previousSnapshot, purpose, managedDecision,
    } = params;
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
    const candidateTargets = buildTargets({
        targetCaps: capsStatus.targetCaps, capabilityObj: overlay.capabilityObj, deviceId, deviceLabel,
        debugStructured,
    });
    const temperature = resolveTemperatureObservation({ currentTemperature, targets: candidateTargets });
    const targets = temperature ? [temperature.target] : [];
    const control = resolveDeviceControlBundle({
        identity, deps, overlay, capsStatus, binaryCapabilityId, powerEstimate, measuredPower,
        previousSnapshot, purpose, managedDecision,
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
        measuredPowerKw: measuredPower.measuredPowerKw,
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
        measuredPowerObservedAtMs: measuredPower.observedAtMs,
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
    measuredPowerKw?: number;
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
        measuredPowerKw,
        measuredPowerObservedAtMs,
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
        stateOfCharge,
        temperature,
        measuredPowerKw,
        measuredPowerObservedAtMs,
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
