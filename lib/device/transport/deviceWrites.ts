/**
 * Device write seam for `DeviceTransport`, extracted as homey-free free
 * functions over a shared `TransportContext`. Applies capability writes (with
 * optimistic binary write-back + binary-settle window start), target batches,
 * previews, and stepped-load step requests. The actual SDK write lands in
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
import { isRealtimeControlCapability } from '../managerRuntime';
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
        snapshotBefore?.controlCapabilityId === capabilityId
          ? snapshotBefore.controlWriteCapabilityId ?? capabilityId
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
    ctx.binarySettleOps.start({
        state: ctx.binarySettleState,
        deps: ctx.getBinarySettleDeps(),
        deviceId,
        capabilityId,
        value: normalizedValue,
        deviceName: snapshotBefore?.name,
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
        ctx.binarySettleOps.clear(ctx.binarySettleState, deviceId, capabilityId);
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

    // Keep local binary turn-off optimistic, but let binary turn-on stay pending until
    // telemetry confirms it. A restore request is intent, not observed truth.
    const preservedLocalState = typeof normalizedValue === 'boolean'
        && isRealtimeControlCapability(capabilityId)
        && normalizedValue === false;
    if (preservedLocalState) {
        ctx.updateLocalSnapshot(deviceId, { on: normalizedValue });
    }

    recordLocalWriteObservation({
        state: ctx.observationState,
        latestSnapshot: ctx.latestSnapshot,
        deviceId,
        capabilityId,
        value: normalizedValue,
        preservedLocalState,
    });

    if (preservedLocalState) {
        // Optimistic shed write mutates binaryControl in place but skips the
        // realtime dispatch funnel; push it so the projection stays faithful.
        // Dispatched AFTER recordLocalWriteObservation, which advances
        // lastLocalWriteMs — so the projected value captures that final
        // timestamp rather than an earlier one (no shadow divergence).
        // Safe: syncLivePlanState is serialized; onoff isn't a SoC capability.
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

export async function requestSteppedLoadStep(ctx: TransportContext, params: {
    deviceId: string;
    profile: SteppedLoadProfile;
    desiredStepId: string;
    planningPowerW: number;
    planningCurrentA: number;
    actuationMode?: 'plan' | 'reconcile';
    previousStepId?: string;
}): Promise<SteppedLoadStepRequestResult> {
    const {
        deviceId,
        profile,
        desiredStepId,
        planningPowerW,
        planningCurrentA,
        actuationMode,
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

    const triggerPromise = triggerCard.trigger({
        step_id: desiredStepId,
        planning_power_w: planningPowerW,
        planning_current_a: planningCurrentA,
        previous_step_id: previousStepId ?? '',
    }, {
        deviceId,
    });
    void Promise.resolve(triggerPromise).catch((error: unknown) => {
        const normalizedError = normalizeError(error);
        (ctx.logger.structuredLog ?? moduleLogger).error({
            event: 'stepped_load_command_failed',
            reasonCode: 'flow_trigger_failed',
            deviceId,
            deviceName: snapshot?.name,
            desiredStepId,
            planningPowerW,
            commandTransport: 'flow',
            ...(actuationMode ? { mode: actuationMode } : {}),
            err: normalizedError,
        });
    });
    return { requested: true, transport: 'flow' };
}

export async function applyDeviceTargets(
    ctx: TransportContext,
    targets: Record<string, number>,
    contextInfo = '',
): Promise<void> {
    if (!ctx.isSdkReady()) {
        ctx.logger.debug({ event: 'sdk_api_unavailable_apply_targets_skipped' });
        return;
    }
    for (const device of ctx.latestSnapshot) {
        const targetValue = targets[device.id];
        if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;
        const targetCap = device.targets?.[0]?.id;
        if (!targetCap) continue;
        try {
            const appliedValue = await setCapability(ctx, device.id, targetCap, targetValue);
            (ctx.logger.structuredLog ?? moduleLogger).info({
                event: 'device_target_applied',
                deviceId: device.id,
                deviceName: device.name,
                capabilityId: targetCap,
                appliedValue,
                context: contextInfo,
            });
        } catch (error) {
            (ctx.logger.structuredLog ?? moduleLogger).error({
                event: 'device_target_apply_failed',
                deviceId: device.id, deviceName: device.name, capabilityId: targetCap,
                targetValue, context: contextInfo, err: normalizeError(error),
            });
        }
    }
    await ctx.refreshSnapshot();
}

export function previewDeviceTargets(
    ctx: TransportContext,
    targets: Record<string, number>,
    contextInfo = '',
): void {
    for (const device of ctx.latestSnapshot) {
        const targetValue = targets[device.id];
        if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;
        const targetCap = device.targets?.[0]?.id;
        if (!targetCap) continue;
        const target = device.targets.find((entry) => entry.id === targetCap);
        const normalizedValue = normalizeTargetCapabilityValue({ target, value: targetValue });
        (ctx.logger.structuredLog ?? moduleLogger).info({
            event: 'device_target_preview',
            deviceId: device.id,
            deviceName: device.name,
            capabilityId: targetCap,
            normalizedValue,
            context: contextInfo,
        });
    }
}
