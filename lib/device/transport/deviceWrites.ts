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
import { logEvCapabilityAccepted, logEvCapabilityRequest } from '../managerControl';
import { hasRestClient, setRawCapabilityValue } from './managerHomeyApi';
import { clearLocalCapabilityWrite, recordLocalCapabilityWrite } from './managerRealtimeSupport';
import { recordLocalWriteObservation } from './managerObservation';
import { setObservedNativeSteppedLoadStep } from '../managerNativeSteppedCommand';
import { isNativeSteppedLoadControlEnabled } from '../nativeSteppedLoadWiring';
import type {
  SteppedLoadStepRequestResult,
} from '../../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { SteppedLoadFlowTriggerCard } from './transportTypes';
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
    writeCapabilityId: string;
    value: unknown;
}): void {
    (ctx.debugStructured ?? ((p: Record<string, unknown>) => moduleLogger.debug(p)))({
        event: params.event,
        deviceId: params.deviceId,
        deviceName: params.deviceName ?? null,
        capabilityId: params.capabilityId,
        writeCapabilityId: params.writeCapabilityId,
        value: params.value,
        valueType: typeof params.value,
    });
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
    const writeCapabilityId = (
        snapshotBefore?.binaryCapabilityId === capabilityId
          ? snapshotBefore.binaryWriteCapabilityId ?? capabilityId
          : capabilityId
    );
    logEvCapabilityRequest({
        logger: ctx.logger,
        snapshotBefore,
        deviceId,
        capabilityId,
        value: normalizedValue,
    });

    incPerfCounter('device_action_total');
    incPerfCounter(`device_action.capability.${capabilityId}`);
    recordLocalCapabilityWrite({
        recentLocalCapabilityWrites: ctx.recentLocalCapabilityWrites,
        deviceId,
        capabilityId,
        value: normalizedValue,
    });
    emitCapabilityWriteDebug(ctx, {
        event: 'device_capability_write_requested',
        deviceId,
        deviceName: snapshotBefore?.name,
        capabilityId,
        writeCapabilityId,
        value: normalizedValue,
    });
    try {
        await setRawCapabilityValue(deviceId, writeCapabilityId, normalizedValue);
    } catch (error) {
        clearLocalCapabilityWrite({
            recentLocalCapabilityWrites: ctx.recentLocalCapabilityWrites,
            deviceId,
            capabilityId,
        });
        throw error;
    }
    emitCapabilityWriteDebug(ctx, {
        event: 'device_capability_write_accepted',
        deviceId,
        deviceName: snapshotBefore?.name,
        capabilityId,
        writeCapabilityId,
        value: normalizedValue,
    });

    recordLocalWriteObservation({
        state: ctx.observationState,
        latestSnapshot: ctx.latestSnapshot,
        deviceId,
        capabilityId,
        value: normalizedValue,
        preservedLocalState: false,
    });
    // The accepted write advances only command metadata (`lastLocalWriteMs`),
    // never observed capability truth. Publish the unchanged observed state so
    // the observer projection remains an exact shadow while confirmation still
    // has to arrive through snapshot/realtime telemetry.
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
            (ctx.logger.structuredLog ?? moduleLogger).error({
                event: 'stepped_load_command_failed',
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
