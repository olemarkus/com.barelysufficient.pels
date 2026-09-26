/**
 * Device write seam for `DeviceTransport`, extracted as homey-free free
 * functions over a shared `TransportContext`. Applies capability writes without
 * fabricating observed truth, plus target batches, previews, and stepped-load
 * step requests. The actual SDK write lands in
 * `managerHomeyApi.setRawCapabilityValue`, which already takes plain data.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { SteppedLoadProfile } from '../../../packages/contracts/src/types';
import { getLogger } from '../../logging/logger';
import { incPerfCounter } from '../../utils/perfCounters';
import { normalizeError } from '../../utils/errorUtils';
import { normalizeTargetCapabilityValue } from '../../utils/targetCapabilities';
import { isSteppedLoadOffStep } from '../../utils/deviceControlProfiles';
import { logEvCapabilityAccepted, logEvCapabilityRequest } from '../managerControl';
import { hasRestClient, setRawCapabilityValue } from './managerHomeyApi';
import { clearLocalCapabilityWrite, recordLocalCapabilityWrite } from './managerRealtimeSupport';
import { recordLocalWriteObservation } from './managerObservation';
import { setObservedNativeSteppedLoadStep } from '../managerNativeSteppedCommand';
import { isNativeSteppedLoadControlEnabled, type CapabilityWrite } from '../nativeSteppedLoadWiring';
import { isEaseeUnderBuiltInControl, resolveEaseeSwitchWrite } from '../easeeChargingSwitch';
import type {
  SteppedLoadStepRequestResult,
} from '../../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { SteppedLoadFlowTriggerCard } from './transportTypes';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { TransportContext } from './transportContext';

const moduleLogger = getLogger('device/transport');
const FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS = 10_000;

function normalizeCapabilityValue(
    ctx: TransportContext,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): unknown {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    const snapshot = ctx.latestSnapshot.find((device) => device.id === deviceId);
    const target = snapshot?.targets.find((entry) => entry.id === capabilityId);
    if (!target) return value;
    return normalizeTargetCapabilityValue({ target, value });
}

function emitCapabilityWriteDebug(ctx: TransportContext, params: {
    event: 'device_capability_write_requested' | 'device_capability_write_accepted';
    deviceId: string;
    deviceName?: string;
    capabilityId: string;
    value: unknown;
    write: CapabilityWrite;
}): void {
    (ctx.debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
        event: params.event,
        deviceId: params.deviceId,
        deviceName: params.deviceName ?? null,
        capabilityId: params.capabilityId,
        writeCapabilityId: params.write.capabilityId,
        value: params.value,
        valueType: typeof params.value,
        writeValue: params.write.value,
    });
}

/**
 * What reaches the SDK for a requested write, which Homey echoes of it are
 * PELS's own, and whether PELS reads the requested capability back as Homey
 * holds it. Only then may the local write stand in for a read that Homey dated
 * before it.
 */
type SdkWrite = {
    write: CapabilityWrite;
    ownEchoes: readonly CapabilityWrite[];
    readBackAsWritten: boolean;
};

/**
 * Where a write to a device's binary switch lands in the SDK: the switch, or the
 * capability the transport routes it to. An Easee may carry out its charging
 * switch through the charger current instead (`resolveEaseeSwitchWrite`).
 * The settle evidence PELS waits for stays on the switch it asked for; the
 * charger current is recorded as PELS's own write too, so its echo is treated
 * like the echo of any other built-in step write rather than as an observation
 * of the charger. An Easee under built-in control reads its switch from the
 * plug state and the current, not from what Homey holds for it, so PELS's own
 * write to the switch is no observation of it either.
 */
function resolveSwitchSdkWrite(
    ctx: TransportContext,
    snapshot: TransportDeviceSnapshot,
    requested: CapabilityWrite,
): SdkWrite {
    const plain: SdkWrite = {
        write: routeSwitchWrite(snapshot, requested),
        ownEchoes: [requested],
        readBackAsWritten: true,
    };
    if (typeof requested.value !== 'boolean') return plain;
    const easeeWrite = resolveEaseeSwitchWrite(snapshot, ctx.getTrackedDevicesById(), requested.value);
    const readBackAsWritten = !isEaseeUnderBuiltInControl(snapshot);
    if (easeeWrite.kind === 'current') {
        return { write: easeeWrite.write, ownEchoes: [requested, easeeWrite.write], readBackAsWritten };
    }
    return { ...plain, readBackAsWritten };
}

function routeSwitchWrite(snapshot: TransportDeviceSnapshot, requested: CapabilityWrite): CapabilityWrite {
    return { capabilityId: snapshot.binaryWriteCapabilityId ?? requested.capabilityId, value: requested.value };
}

export async function setCapability(
    ctx: TransportContext,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): Promise<unknown> {
    if (!hasRestClient()) throw new Error('REST client not ready');
    const normalizedValue = normalizeCapabilityValue(ctx, deviceId, capabilityId, value);
    const snapshotBefore = ctx.latestSnapshot.find((device) => device.id === deviceId);
    const requested: CapabilityWrite = { capabilityId, value: normalizedValue };
    const { write, ownEchoes, readBackAsWritten }: SdkWrite = snapshotBefore?.binaryCapabilityId === capabilityId
        ? resolveSwitchSdkWrite(ctx, snapshotBefore, requested)
        : { write: requested, ownEchoes: [requested], readBackAsWritten: true };
    logEvCapabilityRequest({
        logger: ctx.logger,
        snapshotBefore,
        deviceId,
        capabilityId,
        value: normalizedValue,
    });

    if (capabilityId === 'target_temperature' && typeof normalizedValue === 'number') {
        ctx.temperatureAdjustments.recordCommand(deviceId, normalizedValue, Date.now());
    }
    incPerfCounter('device_action_total');
    incPerfCounter(`device_action.capability.${capabilityId}`);
    for (const echo of ownEchoes) {
        recordLocalCapabilityWrite({
            recentLocalCapabilityWrites: ctx.recentLocalCapabilityWrites,
            deviceId,
            capabilityId: echo.capabilityId,
            value: echo.value,
        });
    }
    emitCapabilityWriteDebug(ctx, {
        event: 'device_capability_write_requested',
        deviceId,
        deviceName: snapshotBefore?.name,
        capabilityId,
        value: normalizedValue,
        write,
    });
    try {
        await setRawCapabilityValue(deviceId, write.capabilityId, write.value);
    } catch (error) {
        for (const echo of ownEchoes) {
            clearLocalCapabilityWrite({
                recentLocalCapabilityWrites: ctx.recentLocalCapabilityWrites,
                deviceId,
                capabilityId: echo.capabilityId,
            });
        }
        throw error;
    }
    emitCapabilityWriteDebug(ctx, {
        event: 'device_capability_write_accepted',
        deviceId,
        deviceName: snapshotBefore?.name,
        capabilityId,
        value: normalizedValue,
        write,
    });

    if (readBackAsWritten) {
        recordLocalWriteObservation({
            state: ctx.observationState,
            latestSnapshot: ctx.latestSnapshot,
            deviceId,
            capabilityId,
            value: normalizedValue,
            preservedLocalState: false,
        });
    }
    // The accepted write publishes no observed value of its own. Publish the
    // unchanged observed state so the observer projection remains an exact
    // shadow while confirmation still has to arrive through snapshot/realtime
    // telemetry. A local write recorded above (`readBackAsWritten`) does count
    // on a later read: a pulled value Homey dated before it gives way to PELS's
    // value (`observationMerge`, `retained_fresher`) until a newer observation
    // arrives.
    if (snapshotBefore?.binaryCapabilityId === capabilityId) {
        ctx.dispatchObservedStateForDevice(deviceId, capabilityId);
    }

    const snapshotAfter = ctx.latestSnapshot.find((device) => device.id === deviceId);
    logEvCapabilityAccepted({
        logger: ctx.logger,
        snapshotAfter,
        deviceId,
        capabilityId,
        value: normalizedValue,
    });
    return normalizedValue;
}

function resolveSteppedLoadFlowTriggerCard(ctx: TransportContext): SteppedLoadFlowTriggerCard | undefined {
    return ctx.getFlowTriggerCard?.('desired_stepped_load_changed');
}

async function awaitFlowTriggerAcceptance(
    trigger: () => Promise<unknown> | unknown,
): Promise<'accepted' | 'timed_out'> {
    let acceptanceTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const triggerResult = Promise.resolve()
            .then(trigger)
            .then(() => 'accepted' as const);
        const timeoutResult = new Promise<'timed_out'>((resolve) => {
            acceptanceTimeout = setTimeout(() => resolve('timed_out'), FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS);
            acceptanceTimeout.unref();
        });
        return await Promise.race([triggerResult, timeoutResult]);
    } finally {
        if (acceptanceTimeout) clearTimeout(acceptanceTimeout);
    }
}

export async function requestSteppedLoadStep(ctx: TransportContext, params: {
    deviceId: string;
    profile: SteppedLoadProfile;
    desiredStepId: string;
    planningPowerW: number;
    planningCurrentA: number;
    previousStepId?: string;
}): Promise<SteppedLoadStepRequestResult> {
    const {
        deviceId,
        profile,
        desiredStepId,
        planningPowerW,
        planningCurrentA,
        previousStepId,
    } = params;
    // A step to the off step is PELS stopping the device: a car-link stop that
    // follows it is PELS's, not the car's.
    if (isSteppedLoadOffStep(profile, desiredStepId)) {
        ctx.observationProducers.evCarLink.noteStopCommand(deviceId, Date.now());
    }
    const snapshot = ctx.latestSnapshotById.get(deviceId);
    if (snapshot && isNativeSteppedLoadControlEnabled(snapshot)) {
        const nativeRequested = await setObservedNativeSteppedLoadStep({
            owner: ctx.owner,
            deviceId,
            profile,
            desiredStepId,
            setCapability: (capabilityId, value) => setCapability(ctx, deviceId, capabilityId, value),
            logger: ctx.logger,
        });
        return nativeRequested ? { requested: true, transport: 'native_capability' } : { requested: false };
    }

    const triggerCard = resolveSteppedLoadFlowTriggerCard(ctx);
    if (!triggerCard?.trigger) return { requested: false };

    try {
        const outcome = await awaitFlowTriggerAcceptance(() => triggerCard.trigger({
            step_id: desiredStepId,
            planning_power_w: planningPowerW,
            planning_current_a: planningCurrentA,
            previous_step_id: previousStepId ?? '',
        }, {
            deviceId,
        }));
        if (outcome === 'timed_out') {
            // Unacknowledged, not failed: the trigger went out and nothing came
            // back. The executor resolves it like a slow success and waits for
            // telemetry, so this must not claim the command definitely failed.
            //
            // Its OWN event, not `stepped_load_command_outcome_unknown`: the
            // executor emits that one for this same trigger, and it is the layer
            // that knows the command's direction and which clocks it stamped.
            // Two layers emitting one event name would double-count every Flow
            // device in any triage that tallies unknown outcomes.
            (ctx.logger.structuredLog ?? moduleLogger).warn({
                event: 'stepped_load_flow_trigger_unacknowledged',
                reasonCode: 'flow_trigger_timeout',
                deviceId,
                deviceName: snapshot?.name,
                desiredStepId,
                planningPowerW,
                commandTransport: 'flow',
                timeoutMs: FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS,
            });
            return { requested: false, reason: 'flow_trigger_timeout' };
        }
        return { requested: true, transport: 'flow' };
    } catch (error: unknown) {
        const normalizedError = normalizeError(error);
        (ctx.logger.structuredLog ?? moduleLogger).error({
            event: 'stepped_load_command_failed',
            reasonCode: 'flow_trigger_failed',
            deviceId,
            deviceName: snapshot?.name,
            desiredStepId,
            planningPowerW,
            commandTransport: 'flow',
            err: normalizedError,
        });
        return { requested: false };
    }
}
