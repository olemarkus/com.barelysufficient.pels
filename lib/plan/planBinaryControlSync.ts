import type { PlanEngineState } from './planState';
import type { PendingTargetObservationSource, PlanInputDevice } from './planTypes';
import {
  getPendingBinaryCommandWindowMs,
  isPendingBinaryCommandActive,
} from './planObservationPolicy';
import { getLogger } from '../logging/logger';
import { formatPendingBinaryObservedValue } from './planBinaryControlHelpers';

const logger = getLogger('plan/binary-sync');

export function syncPendingBinaryCommands(params: {
  state: PlanEngineState;
  liveDevices: PlanInputDevice[];
  source: PendingTargetObservationSource;
  onConfirmed?: (params: {
    deviceId: string;
    liveDevice: PlanInputDevice;
    pending: PlanEngineState['pendingBinaryCommands'][string];
    source: PendingTargetObservationSource;
    confirmedAtMs: number;
  }) => void;
}): boolean {
  const {
    state,
    liveDevices,
    source,
    onConfirmed,
  } = params;
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  const nowMs = Date.now();
  let changed = false;

  for (const [deviceId, pending] of Object.entries(state.pendingBinaryCommands)) {
    const liveDevice = liveById.get(deviceId);
    const ageMs = nowMs - pending.startedMs;
    if (!isPendingBinaryCommandActive({
      pending,
      nowMs,
      communicationModel: liveDevice?.communicationModel,
    })) {
      delete state.pendingBinaryCommands[deviceId];
      changed = true;
      logger.debug({
        event: 'pending_binary_command_timed_out',
        deviceId,
        deviceName: liveDevice ? liveDevice.name : undefined,
        capabilityId: pending.capabilityId,
        desired: pending.desired,
        ageMs,
        timeoutMs: getPendingBinaryCommandWindowMs(pending),
        lastObservedValue: pending.lastObservedValue,
        lastObservedSource: pending.lastObservedSource,
      });
      continue;
    }
    if (!liveDevice) continue;

    const observation = getSettlingBinaryObservation(liveDevice, pending);
    if (!observation) continue;
    const observedValue = observation.observedValue;
    if (observedValue === pending.desired) {
      onConfirmed?.({
        deviceId,
        liveDevice,
        pending,
        source,
        confirmedAtMs: observation.observedAtMs,
      });
      delete state.pendingBinaryCommands[deviceId];
      changed = true;
      logger.debug({
        event: 'pending_binary_command_confirmed',
        deviceId,
        deviceName: liveDevice.name,
        capabilityId: pending.capabilityId,
        observedValue: formatPendingBinaryObservedValue(pending.capabilityId, observedValue),
        source,
      });
      continue;
    }

    if (
      pending.lastObservedValue === observedValue
      && pending.lastObservedSource === source
      && pending.lastObservedAtMs === observation.observedAtMs
    ) {
      continue;
    }

    pending.lastObservedValue = observedValue;
    pending.lastObservedSource = source;
    pending.lastObservedAtMs = observation.observedAtMs;
    changed = true;
    logger.debug({
      event: 'pending_binary_command_waiting',
      deviceId,
      deviceName: liveDevice.name,
      capabilityId: pending.capabilityId,
      observedValue: formatPendingBinaryObservedValue(pending.capabilityId, observedValue),
      expected: formatPendingBinaryObservedValue(pending.capabilityId, pending.desired),
      source,
    });
  }

  return changed;
}

function getSettlingBinaryObservation(
  liveDevice: PlanInputDevice,
  pending: PlanEngineState['pendingBinaryCommands'][string],
): NonNullable<PlanInputDevice['binaryControlObservation']> | undefined {
  const observation = liveDevice.binaryControlObservation;
  if (!observation) return undefined;
  if (observation.capabilityId !== pending.capabilityId) return undefined;
  if (!Number.isFinite(observation.observedAtMs)) return undefined;
  if (observation.observedAtMs <= pending.startedMs) return undefined;
  if (pending.capabilityId === 'evcharger_charging') return resolveSettlingEvObservation(liveDevice, observation);
  return observation;
}

function resolveSettlingEvObservation(
  liveDevice: PlanInputDevice,
  observation: NonNullable<PlanInputDevice['binaryControlObservation']>,
): NonNullable<PlanInputDevice['binaryControlObservation']> | undefined {
  const rawStateValue = liveDevice.evChargingState;
  if (rawStateValue === undefined) {
    return observation.observedCapabilityIds.includes('evcharger_charging_state')
      ? undefined
      : observation;
  }
  const observedFromState = observation.observedCapabilityIds.includes('evcharger_charging_state');
  if (!observedFromState) return undefined;
  return observation;
}
