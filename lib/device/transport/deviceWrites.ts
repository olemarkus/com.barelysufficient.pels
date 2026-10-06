/**
 * Device write service for `DeviceTransport`. Applies capability writes without
 * fabricating observed truth, plus target batches, previews, and stepped-load
 * step requests. The actual SDK write lands in
 * `managerHomeyApi.setRawCapabilityValue`, which already takes plain data.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { SteppedLoadWrite } from '../../ports/steppedLoadWrite';
import type { StoragePowerCommand, StoragePowerWrite, StorageReleaseCommand } from '../../ports/storageCommand';
import type { HomeBatteryControlSurface } from '../../../packages/contracts/src/types';
import { getDebugEmitter } from '../../logging/logger';
import { incPerfCounter } from '../../utils/perfCounters';
import { normalizeError } from '../../utils/errorUtils';
import { resolveHomeyHttpStatusCode } from '../../utils/homeyHttpStatusError';
import { normalizeTargetCapabilityValue } from '../../../packages/shared-domain/src/targetCapabilities';
import { isSteppedLoadOffStep } from '../../../packages/shared-domain/src/deviceControlProfiles';
import { logEvCapabilityAccepted, logEvCapabilityRequest } from '../managerControl';
import { hasRestClient, setRawCapabilityValue } from './managerHomeyApi';
import { recordLocalWriteObservation } from './managerObservation';
import { setObservedNativeSteppedLoadStep } from '../managerNativeSteppedCommand';
import { isNativeSteppedLoadControlEnabled, type CapabilityWrite } from '../nativeSteppedLoadWiring';
import { isEaseeUnderBuiltInControl, resolveEaseeSwitchWrite } from '../easeeChargingSwitch';
import type {
  SteppedLoadStepRequestResult,
} from '../../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { SteppedLoadFlowTriggerCard } from './transportTypes';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import type { Logger } from '../../utils/types';
import type { TemperatureAdjustmentObserver } from '../temperatureAdjustmentObserver';
import { isCanSetControl } from '../deviceActionProjection';
import { HOME_BATTERY_SETPOINT_CAPABILITY_ID, toTargetPowerCapabilityValue } from '../batteryControlWiring';
import { isHomeBatterySnapshot } from './homeBatteryObservation';
import { TransportSnapshotStore } from './transportSnapshotStore';
import { TransportObservationState } from './transportObservationState';

const emitTransportDebug = getDebugEmitter('devices', 'devices');
const FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS = 10_000;

function normalizeCapabilityValue(
    snapshotStore: TransportSnapshotStore,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): unknown {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    const snapshot = snapshotStore.getSnapshotByDeviceId(deviceId);
    const target = snapshot?.targets.find((entry) => entry.id === capabilityId);
    if (!target) return value;
    return normalizeTargetCapabilityValue({ target, value });
}

function emitCapabilityWriteDebug(
    event: 'device_capability_write_requested' | 'device_capability_write_accepted',
    deviceId: string,
    capabilityId: string,
    value: unknown,
    write: CapabilityWrite,
): void {
    emitTransportDebug({
        event,
        deviceId,
        capabilityId,
        writeCapabilityId: write.capabilityId,
        value,
        valueType: typeof value,
        writeValue: write.value,
    });
}

/**
 * What reaches the SDK for a requested write, and whether PELS reads the
 * requested capability back as Homey holds it. Only then may the local write
 * stand in for a read that Homey dated before it.
 */
type SdkWrite = {
    write: CapabilityWrite;
    readBackAsWritten: boolean;
};

/**
 * Where a write to a device's binary switch lands in the SDK: the switch, or the
 * capability the transport routes it to. An Easee may carry out its charging
 * switch through the charger current instead (`resolveEaseeSwitchWrite`).
 * The settle evidence PELS waits for stays on the switch it asked for, and only
 * the switch is recorded as PELS's own write: an Easee current's echo is always an
 * observation (`nativeSteppedRealtime.ts`). An Easee under built-in control reads
 * its switch from the plug state and the current, not from what Homey holds for
 * it, so PELS's own write to the switch is no observation of it either.
 */
function resolveSwitchSdkWrite(
    snapshot: TransportDeviceSnapshot,
    trackedDevice: HomeyDeviceLike | undefined,
    requested: CapabilityWrite,
): SdkWrite {
    const plain: SdkWrite = {
        write: routeSwitchWrite(snapshot, requested),
        readBackAsWritten: true,
    };
    if (typeof requested.value !== 'boolean') return plain;
    const easeeWrite = resolveEaseeSwitchWrite(snapshot, trackedDevice, requested.value);
    const readBackAsWritten = !isEaseeUnderBuiltInControl(snapshot);
    if (easeeWrite.kind === 'current') {
        return { write: easeeWrite.write, readBackAsWritten };
    }
    return { ...plain, readBackAsWritten };
}

/**
 * The setpoint surface a storage intent's writes are resolved from. A device
 * that is not a home battery, or one PELS can only observe, has no storage
 * binding: the intent is refused, never improvised.
 */
function requireSetpointSurface(
    snapshot: TransportDeviceSnapshot | undefined,
    deviceId: string,
): Extract<HomeBatteryControlSurface, { kind: 'setpoint' }> {
    if (snapshot === undefined || !isHomeBatterySnapshot(snapshot)) {
        throw new Error(`No home battery binding for device ${deviceId}`);
    }
    const surface = snapshot.homeBattery.controlSurface;
    if (surface.kind !== 'setpoint') {
        throw new Error(`Home battery ${deviceId} is observe-only (${surface.reason})`);
    }
    return surface;
}

function routeSwitchWrite(snapshot: TransportDeviceSnapshot, requested: CapabilityWrite): CapabilityWrite {
    return { capabilityId: snapshot.binaryWriteCapabilityId ?? requested.capabilityId, value: requested.value };
}

export class DeviceWriteService {
  constructor(
    private readonly snapshotStore: TransportSnapshotStore,
    private readonly observationState: TransportObservationState,
    private readonly logger: Logger,
    private readonly temperatureAdjustments: TemperatureAdjustmentObserver,
    private readonly getFlowTriggerCard: (cardId: string) => SteppedLoadFlowTriggerCard | undefined,
    private readonly dispatchObservedStateForDevice: (deviceId: string, capabilityId?: string) => void,
    private readonly noteStopCommand: (deviceId: string, nowMs: number) => void,
  ) {}

  /** Actuator preflight, resolved against the current transport snapshot. */
  canTurnOnDevice(deviceId: string): boolean {
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    return snapshot !== undefined
      && snapshot.available !== false
      && isCanSetControl(snapshot);
  }

  async setCapability(deviceId: string, capabilityId: string, value: unknown): Promise<unknown> {
    if (!hasRestClient()) throw new Error('REST client not ready');
    const normalizedValue = normalizeCapabilityValue(this.snapshotStore, deviceId, capabilityId, value);
    const snapshotBefore = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    const requested: CapabilityWrite = { capabilityId, value: normalizedValue };
    const { write, readBackAsWritten }: SdkWrite = snapshotBefore?.binaryCapabilityId === capabilityId
        ? resolveSwitchSdkWrite(
          snapshotBefore,
          this.snapshotStore.getTrackedRawDevice(deviceId),
          requested,
        )
        : { write: requested, readBackAsWritten: true };
    logEvCapabilityRequest({
        snapshotBefore,
        deviceId,
        capabilityId,
        value: normalizedValue,
    });

    if (capabilityId === 'target_temperature' && typeof normalizedValue === 'number') {
        this.temperatureAdjustments.recordCommand(deviceId, normalizedValue, Date.now());
    }
    incPerfCounter('device_action_total');
    incPerfCounter(`device_action.capability.${capabilityId}`);
    this.observationState.recordLocalCapabilityWrite(deviceId, capabilityId, normalizedValue);
    emitCapabilityWriteDebug(
        'device_capability_write_requested',
        deviceId,
        capabilityId,
        normalizedValue,
        write,
    );
    try {
        await setRawCapabilityValue(deviceId, write.capabilityId, write.value);
    } catch (error) {
        this.observationState.clearLocalCapabilityWrite(deviceId, capabilityId);
        throw error;
    }
    emitCapabilityWriteDebug(
        'device_capability_write_accepted',
        deviceId,
        capabilityId,
        normalizedValue,
        write,
    );

    if (readBackAsWritten) {
        recordLocalWriteObservation({
            state: this.observationState.getObservationState(),
            latestSnapshot: this.snapshotStore.getSnapshot(),
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
        this.dispatchObservedStateForDevice(deviceId, capabilityId);
    }

    const snapshotAfter = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    logEvCapabilityAccepted({
        snapshotAfter,
        deviceId,
        capabilityId,
        value: normalizedValue,
    });
    return normalizedValue;
  }

  /**
   * A home battery's signed setpoint: the claim capability is written to its
   * Homey value first, unless the battery already reports that value, then
   * `target_power` takes the setpoint mapped onto the battery's declared range.
   * Returns the watts written. A battery that reports Homey's value while it
   * no longer holds it is caught by the storage lane's claim check, as any
   * other claim lost after a setpoint is.
   *
   * The setpoint is never written after a claim write that failed. A claim
   * write Homey answered with an HTTP error status resolves as
   * `claim_rejected`, for the battery owner to judge against the binding. A
   * claim write with no answer (a timeout, a connection reset, an unreadable
   * 2xx: its outcome unknown), a refused setpoint and a missing REST client
   * throw.
   */
  async requestStoragePower(command: StoragePowerCommand): Promise<StoragePowerWrite> {
    const { deviceId } = command;
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    const surface = requireSetpointSurface(snapshot, deviceId);
    // Checked here as well as in `setCapability`, so a write that never left
    // PELS is not mistaken for one the battery's app rejected.
    if (!hasRestClient()) throw new Error('REST client not ready');
    if (snapshot?.batteryClaim?.value !== surface.claim.homeyValue) {
      try {
        await this.setCapability(deviceId, surface.claim.capabilityId, surface.claim.homeyValue);
      } catch (error) {
        // Only an answer is a rejection: an HTTP error status, which is how
        // Homey returns a capability listener's throw (an app's own error comes
        // back as HTTP 500, as myUplink's "Failed to change the settings." does).
        // A timeout, a connection reset or an unreadable 2xx may have landed: its
        // outcome is unknown, and it throws like any other failed write.
        if (resolveHomeyHttpStatusCode(error) === undefined) throw error;
        return { kind: 'claim_rejected', errorMessage: normalizeError(error).message };
      }
    }
    const setpointW = toTargetPowerCapabilityValue(command.setpointW, surface.range);
    await this.setCapability(deviceId, HOME_BATTERY_SETPOINT_CAPABILITY_ID, setpointW);
    return { kind: 'written', setpointW };
  }

  /**
   * Hand a battery back: `target_power` 0 first, so the battery is idle before
   * anyone else holds it, then the claim capability is restored to the value
   * recorded before PELS claimed it. The restore is written even when the 0 W
   * write failed: a battery back under its own mode no longer follows the
   * setpoint, while one left under Homey's claim would hold its last setpoint
   * through every retry back-off. Either failure then throws, the restore's
   * first. Whether the battery is still PELS's to hand back, and whether its
   * claim capability declares that value, is the battery owner's call, made
   * against its claim record; this writes unconditionally.
   */
  async releaseStorageControl(command: StorageReleaseCommand): Promise<void> {
    const { deviceId, restoreClaimValue } = command;
    const surface = requireSetpointSurface(this.snapshotStore.getSnapshotByDeviceId(deviceId), deviceId);
    const zeroed = await this.setCapability(deviceId, HOME_BATTERY_SETPOINT_CAPABILITY_ID, 0).then(
      () => ({ failed: false as const }),
      (error: unknown) => ({ failed: true as const, error }),
    );
    await this.setCapability(deviceId, surface.claim.capabilityId, restoreClaimValue);
    if (zeroed.failed) throw zeroed.error;
  }

  async requestSteppedLoadStep(
    params: SteppedLoadWrite,
  ): Promise<SteppedLoadStepRequestResult> {
    const {
      deviceId,
      profile,
      desiredStepId,
      planningPowerW,
      planningCurrentA,
      previousStepId,
    } = params;
    if (isSteppedLoadOffStep(profile, desiredStepId)) this.noteStopCommand(deviceId, Date.now());
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    if (snapshot && isNativeSteppedLoadControlEnabled(snapshot)) {
      const nativeRequested = await setObservedNativeSteppedLoadStep({
        owner: this.snapshotStore,
        deviceId,
        profile,
        desiredStepId,
        setCapability: (capabilityId, value) => this.setCapability(deviceId, capabilityId, value),
        logger: this.logger,
      });
      return nativeRequested ? { requested: true, transport: 'native_capability' } : { requested: false };
    }

    const triggerCard = this.getFlowTriggerCard('desired_stepped_load_changed');
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
        this.logger.structuredLog.warn({
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
      this.logger.structuredLog.error({
        event: 'stepped_load_command_failed',
        reasonCode: 'flow_trigger_failed',
        deviceId,
        deviceName: snapshot?.name,
        desiredStepId,
        planningPowerW,
        commandTransport: 'flow',
        err: normalizeError(error),
      });
      return { requested: false };
    }
  }
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
