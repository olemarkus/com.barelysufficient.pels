import type { RetainedPowerReading } from '../retainedPowerStore';
import { hasObservedMeasuredPower } from '../../../packages/shared-domain/src/measuredPowerObservedState';
import type {
  NativeRelayMeter, TargetDeviceSnapshot,
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
    getIsAvailable,
    isBatteryOrSolarClassKey,
    resolveZoneId,
    resolveZoneLabel,
} from './managerHelpers';
import {
  getControlCapabilityId,
  toCapabilityTimestampMs,
} from '../managerControl';
import {
    buildTargets,
    resolveDeviceCapabilities,
} from './managerParse';
import {
    hasPotentialHomeyEnergyEstimate,
    isHomeBatteryDevice,
    isSolarPanelDevice,
    type LiveDevicePowerWatts,
} from '../managerEnergy';
import { resolveMeasuredPowerKw } from '../managerMeasuredPower';
import { resolveChargerPhaseCurrentsA } from '../chargerPhaseCurrents';
import {
    resolveCandidateCapabilities,
    resolveFlowCapabilityOverlay,
} from '../managerNativeEv';
import { shouldSkipFlowBackedCandidate } from '../managerFlowSupport';
import {
    resolveBinaryControlObservation,
    type DeviceSnapshotControl,
} from './managerParseSnapshot';
import {
    resolveStateOfChargeSnapshot,
    withRetainedEvSessionState,
    } from './stateOfCharge';
import { resolveDeviceParsedControlState } from './managerParsedControlState';
import type { ParsedDeviceIdentity } from './managerParseIdentity';
import {
    shouldDropAfterControlState,
    type ManagedFilterDecision,
} from './managerManagedFilter';
import type {
    DeviceTransportParseDeps,
    DeviceParseSources,
    ParseDevicePurpose,
    RetainedMeasurement,
} from './managerParseDevice';
import { resolveDevicePowerState } from './managerParsePowerState';
import { resolveLastFreshDataMs } from './managerParseFreshness';
import { withInverterParseFields } from './solarInverterObservation';
import { withHomeBatteryParseFields } from './homeBatteryObservation';
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

export function resolveDeviceCapabilityProfile(
    identity: ParsedDeviceIdentity,
    deps: DeviceTransportParseDeps,
): DeviceCapabilityProfile | null {
    const { effectiveDevice } = identity;
    const { logger, getCapabilityObj } = deps;
    const rawCapabilities = getCapabilities(effectiveDevice);
    const rawCapabilityObj = getCapabilityObj(effectiveDevice);
    const overlay = resolveFlowCapabilityOverlay(identity, rawCapabilities, rawCapabilityObj, deps, logger);
    const capsStatus = resolveCandidateCapabilities(identity, overlay,
        resolveSelectedBinaryCapability(effectiveDevice, overlay));
    if (!capsStatus) return null;
    return { overlay, capsStatus };
}

/**
 * The device's raw reported `thermostat_mode`.
 *
 * Reported, not interpreted: the vocabulary that turns this into a direction is
 * the observer's (`resolveThermalDirection`). A read that reaches the parse
 * conformed to the device-read contract (`deviceReadContract.ts`), so a declared
 * mode came with a string value: a `null` one was withheld there, and nothing
 * is carried over here. A blank string is no mode at all.
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

function resolveRetainedReading(
    previousSnapshot: TransportDeviceSnapshot | undefined,
    restored: RetainedPowerReading | undefined,
): RetainedMeasurement | undefined {
    if (previousSnapshot === undefined) {
        // The store keeps only readings a cumulative meter resolved
        // (`retainedPowerPersistence.ts`): a direct one is re-read at once.
        return restored === undefined ? undefined : { ...restored, source: 'meter_power' };
    }
    if (!hasObservedMeasuredPower(previousSnapshot)) return undefined;
    return {
        measuredPowerKw: previousSnapshot.measuredPowerKw,
        ...(previousSnapshot.measuredPowerObservedAtMs !== undefined
            ? { observedAtMs: previousSnapshot.measuredPowerObservedAtMs } : {}),
        ...(previousSnapshot.measuredPowerReading !== undefined
            ? { reading: previousSnapshot.measuredPowerReading } : {}),
        ...(previousSnapshot.measuredPowerSource !== undefined
            ? { source: previousSnapshot.measuredPowerSource } : {}),
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
        source: retained.source,
    };
}

function resolveDeviceSnapshotControl(params: {
    identity: ParsedDeviceIdentity;
    deps: DeviceTransportParseDeps;
    overlay: DeviceCapabilityProfile['overlay'];
    capsStatus: DeviceCapabilityProfile['capsStatus'];
    binaryCapabilityId?: TransportDeviceSnapshot['binaryCapabilityId'];
    measuredPower: ReturnType<typeof resolveMeasuredPowerKw>;
    previousSnapshot?: TransportDeviceSnapshot;
    retainedReading: RetainedMeasurement | undefined;
    admittedTemperature: boolean;
    purpose: ParseDevicePurpose;
    managedDecision: ManagedFilterDecision;
}): DeviceSnapshotControl | null {
    const {
        identity, deps, overlay, capsStatus, binaryCapabilityId, measuredPower,
        previousSnapshot, retainedReading, admittedTemperature, purpose, managedDecision,
    } = params;
    const { effectiveDevice, deviceClassKey } = identity;
    const { logger, isPowerCapable } = deps;
    const {
        resolvedOn, binaryControl, canSetControl, observedCurrentOn,
        evCharging, evChargingState,
    } = resolveDeviceParsedControlState(
        identity, logger, overlay, binaryCapabilityId, previousSnapshot, purpose === 'ui_picker',
    );
    if (shouldDropAfterControlState({
        purpose, decision: managedDecision, currentOn: resolvedOn, deviceClassKey,
        admittedTemperature: effectiveDevice.genericSetupEnabled && admittedTemperature,
    })) {
        return null;
    }
    const available = getIsAvailable(effectiveDevice);
    const powerCapable = isPowerCapable(effectiveDevice, capsStatus, measuredPower, retainedReading);
    if (shouldSkipFlowBackedCandidate({
        flowAugmentedDeviceType: overlay.flowAugmentedDeviceType,
        flowBackedCapabilityIds: overlay.flowBackedCapabilityIds,
        capabilities: overlay.capabilities, capabilityObj: overlay.capabilityObj,
        requiredFlowCapabilityIds: overlay.requiredFlowCapabilityIds,
        reportedCapabilities: overlay.reportedCapabilities, powerCapable,
        nativeOnOffControl: binaryCapabilityId === 'onoff' && binaryControl !== undefined,
    })) {
        return null;
    }
    return {
        binaryCapabilityId, evCharging, evChargingState, binaryControl, canSetControl,
        hasObservedBinaryControl: observedCurrentOn !== undefined, available, powerCapable,
    };
}

function resolveExternalPowerSocketId(power: DeviceTransportParseDeps['externalPower']): string | undefined {
    return power?.kind === 'external' ? power.socketId : undefined;
}

function resolveSameSourceRetainedReading(
    deviceId: string,
    deps: DeviceTransportParseDeps,
    previousSnapshot: TransportDeviceSnapshot | undefined,
): RetainedMeasurement | undefined {
    const { externalPower } = deps;
    if (externalPower?.kind === 'external') {
        if (!externalPower.capability || previousSnapshot?.externalPowerSocketId !== externalPower.socketId) {
            return undefined;
        }
        return resolveRetainedReading(previousSnapshot, undefined);
    }
    if (previousSnapshot?.externalPowerSocketId) return undefined;
    return resolveRetainedReading(previousSnapshot, deps.getRestoredPowerReading(deviceId));
}

function resolveSelectedBinaryCapability(
    device: ParsedDeviceIdentity['effectiveDevice'],
    overlay: DeviceCapabilityProfile['overlay'],
): string | undefined {
    const id = device.selectedBinarySwitch?.id;
    if (!id || !device.selectedBinarySwitch?.declaredReadableSwitch || !overlay.capabilities.includes(id)
        || overlay.steppedLoadProfile || overlay.pendingSteppedLoad) return undefined;
    const field = overlay.capabilityObj[id];
    return field?.setable === true && typeof field.value === 'boolean' ? id : undefined;
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
    // Resolved once here and handed to both consumers: the power estimate needs it
    // for the EV rung of its default, and the snapshot control needs it for
    // everything else. It is a pure function of (deviceClassKey, capabilities), so
    // a second call could not disagree — but one call is one fewer thing to keep
    // in step.
    const binaryCapabilityId = effectiveDevice.selectedBinarySwitch !== undefined
        ? resolveSelectedBinaryCapability(effectiveDevice, overlay)
        : getControlCapabilityId({
        deviceClassKey,
        capabilities: overlay.capabilities,
    });
    const { currentTemperature, measuredPower, powerEstimate } = resolveDevicePowerState(
        identity, deps, overlay, binaryCapabilityId, livePowerWByDeviceId, now,
    );
    // Keep the last trusted measurement when a refresh has no newer sample.
    // In particular, re-reading one `meter_power` sample must not drop admission.
    const retainedReading = resolveSameSourceRetainedReading(deviceId, deps, previousSnapshot);
    const resolvedMeasuredPower = resolveRetainedMeasuredPower(
        effectiveDevice, capsStatus, measuredPower, retainedReading,
    );
    const candidateTargets = buildTargets({
        targetCaps: capsStatus.targetCaps, capabilityObj: overlay.capabilityObj, deviceId, deviceLabel,
    });
    const temperature = resolveTemperatureObservation(currentTemperature, candidateTargets);
    const thermostatMode = readReportedThermostatMode(overlay);
    const control = resolveDeviceSnapshotControl({
        identity, deps, overlay, capsStatus, binaryCapabilityId,
        measuredPower: resolvedMeasuredPower,
        previousSnapshot, retainedReading, admittedTemperature: temperature !== undefined, purpose, managedDecision,
    });
    if (!control) return null;
    // A rejected member gates its temperature facet, not valid sibling controls.
    if (capsStatus.targetCaps.length > 0 && !temperature
        && !control.binaryCapabilityId && !overlay.steppedLoadProfile && !overlay.pendingSteppedLoad) return null;
    const lastFreshDataMs = resolveLastFreshDataMs(overlay, control, temperature !== undefined, measuredPower);
    const evChargingObservedAtMs = toCapabilityTimestampMs(overlay.capabilityObj.evcharger_charging?.lastUpdated);
    const evChargingStateObservedAtMs = toCapabilityTimestampMs(
        overlay.capabilityObj.evcharger_charging_state?.lastUpdated,
    );
    const stateOfCharge = resolveStateOfChargeSnapshot(
        deviceClassKey, withRetainedEvSessionState(overlay.capabilityObj, previousSnapshot),
        overlay.reportedCapabilities, previousSnapshot?.stateOfCharge,
        deps.settings.getEvCarAssociationCarIds(deviceId),
    );
    const binaryControlObservation = resolveBinaryControlObservation(overlay, control.binaryCapabilityId);
    const parsed: TransportDeviceSnapshot = {
        id: deviceId,
        name: effectiveDevice.name,
        targets: temperature ? [temperature.target] : [],
        deviceClass: deviceClassKey,
        deviceType: resolveTargetDeviceType(temperature),
        ...resolveParsedDeviceSettings(effectiveDevice, deviceId, deps),
        controlModel: overlay.controlModel,
        binaryControllable: control.binaryControl !== undefined,
        isEvCharger: deviceClassKey === 'evcharger',
        ...resolveParsedChargerPhaseCurrents(deviceClassKey, effectiveDevice, previousSnapshot),
        isBatteryOrSolar: isBatteryOrSolarClassKey(deviceClassKey),
        steppedLoadProfile: overlay.steppedLoadProfile,
        pendingSteppedLoad: overlay.pendingSteppedLoad,
        manualFlowSteppedLoad: overlay.manualFlowSteppedLoad,
        nativeWriteCapabilities: overlay.nativeWriteCapabilities,
        targetPowerConfig: overlay.targetPowerConfig,
        automaticPowerControl: overlay.automaticPowerControl,
        binaryCapabilityId: control.binaryCapabilityId,
        ...(effectiveDevice.selectedBinarySwitch
            ? { binarySwitchSelectionRevision: effectiveDevice.selectedBinarySwitch.revision } : {}),
        expectedPowerKw: powerEstimate.expectedPowerKw,
        expectedPowerSource: powerEstimate.expectedPowerSource,
        powerCapable: control.powerCapable,
        binaryControl: control.binaryControl,
        evCharging: control.evCharging,
        evChargingObservedAtMs,
        evChargingState: control.evChargingState,
        evChargingStateObservedAtMs,
        thermostatMode,
        stateOfCharge,
        temperature,
        nativeRelayMeter: readNativeRelayMeter(effectiveDevice.capabilities, measuredPower, deps.externalPower),
        measuredPowerKw: resolvedMeasuredPower.measuredPowerKw,
        measuredPowerObservedAtMs: resolvedMeasuredPower.observedAtMs,
        measuredPowerReading: resolvedMeasuredPower.reading,
        measuredPowerSource: resolvedMeasuredPower.source,
        externalPowerSocketId: resolveExternalPowerSocketId(deps.externalPower),
        zone: resolveZoneLabel(effectiveDevice),
        zoneId: resolveZoneId(effectiveDevice),
        capabilities: overlay.capabilities,
        controlAdapter: overlay.controlAdapter,
        binaryWriteCapabilityId: overlay.binaryWriteCapabilityId,
        binaryObservationCapabilityId: overlay.binaryObservationCapabilityId,
        binaryControlObservation,
        reportedStepId: overlay.reportedStepId,
        reportedStepPowerW: overlay.reportedStepPowerW,
        reportedStepObservedAtMs: overlay.reportedStepObservedAtMs,
        ...(overlay.acknowledgedStep ? { acknowledgedStep: overlay.acknowledgedStep } : {}),
        suggestedSteppedLoadProfile: overlay.suggestedSteppedLoadProfile,
        ...(overlay.flowBackedCapabilityIds.length > 0 ? {
            flowBacked: true,
            flowBackedCapabilityIds: overlay.flowBackedCapabilityIds,
        } : {}),
        canSetControl: control.canSetControl,
        available: control.available,
        lastFreshDataMs,
        lastUpdated: lastFreshDataMs,
    };
    return withInverterParseFields(
        withHomeBatteryParseFields(parsed, effectiveDevice, deviceClassKey, overlay, previousSnapshot),
        effectiveDevice, overlay.capabilityObj, previousSnapshot,
    );
}

function resolveParsedChargerPhaseCurrents(
    deviceClassKey: string,
    device: HomeyDeviceLike,
    previousSnapshot: TransportDeviceSnapshot | undefined,
): Pick<TransportDeviceSnapshot, 'chargerPhaseCurrentsA'> {
    if (deviceClassKey !== 'evcharger') return {};
    const chargerPhaseCurrentsA = resolveChargerPhaseCurrentsA(device, previousSnapshot?.chargerPhaseCurrentsA);
    return chargerPhaseCurrentsA ? { chargerPhaseCurrentsA } : {};
}

function resolveParsedDeviceSettings(
    device: HomeyDeviceLike,
    deviceId: string,
    sources: DeviceParseSources,
): ParsedDeviceSettings {
    const base = {
        controllable: sources.management.isCapacityControlEnabled(deviceId),
        managed: sources.management.isManaged(deviceId),
        budgetExempt: sources.settings.isBudgetExempt(deviceId),
        flowConflict: sources.nativeWiring.getFlowConflict(deviceId),
    };
    // A role-detected battery or solar device is stamped NOT CONTROLLABLE structurally,
    // from the device object in hand, on EVERY parse path (full refresh AND realtime
    // `device.update`): neither is a load the generic shed/restore lanes may command,
    // so there is no window (boot, realtime-before-first-full-refresh, any settings
    // combo) where one resolves `controllable: true`. A battery is commanded only
    // through the storage lane (`lib/battery/`). Detection is the SAME predicate the
    // class-key normalization and snapshot-survival gates use.
    //
    // Managed differs by role. A solar device is always read and never offered to
    // the owner, so it is stamped managed. A home battery is an ordinary managed
    // device: `DeviceManagement.isManaged` answers from the owner's battery-control setting
    // (`lib/battery/batteryControlSettings.ts`), and the managed filter keeps it in
    // the runtime snapshot either way (`managerManagedFilter.ts`).
    if (isSolarPanelDevice(device)) return { ...base, managed: true, controllable: false };
    if (isHomeBatteryDevice(device)) return { ...base, controllable: false };
    return base;
}

/** Keep the device-clock sample apart from later receipt-clock updates to the accounting reading. */
function readNativeRelayMeter(
    capabilities: readonly string[],
    power: ReturnType<typeof resolveMeasuredPowerKw>,
    externalPower: DeviceTransportParseDeps['externalPower'],
): NativeRelayMeter | undefined {
    if (externalPower?.kind === 'external' || !capabilities.includes('onoff')) return undefined;
    const watts = capabilities.includes('measure_power') && power.source === 'measure_power'
        && power.measuredPowerKw !== undefined && power.observedAtMs !== undefined
        ? { value: power.measuredPowerKw * 1000, atMs: power.observedAtMs, sourceDated: true } : undefined;
    const meter = capabilities.includes('meter_power') ? power.meterEnergy : undefined;
    const energy = meter && { kwh: meter.kwh, atMs: meter.observedAtMs };
    return watts || energy ? { watts, energy } : undefined;
}
