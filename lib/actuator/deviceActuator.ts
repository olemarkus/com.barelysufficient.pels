import { SteppedLoadTransportError } from '../ports/steppedLoadWrite';
import { isHomeyRequestTimeout } from '../utils/errorUtils';
import type { ActuatorOutcome, ActuatorTransport, DeviceCommand } from './deviceCommand';

/**
 * The single write seam. Every device write the runtime issues flows through an
 * `Actuator`: it translates a channel-blind {@link DeviceCommand} onto transport's
 * capability/channel writes, and is the only place that maps intent → SDK call.
 *
 * It owns *mechanism* only. Transport privately resolves channel routing.
 * Cooldowns live in `lib/plan`; executor owns pending intent and observer
 * confirms every binary command before actuation is accounted.
 *
 * See `notes/state-management/actuator-write-seam.md`.
 */
export type Actuator = {
  canTurnOnDevice: (deviceId: string) => boolean;
  apply: (command: DeviceCommand) => Promise<ActuatorOutcome>;
  resolveTemperatureTarget: (deviceId: string, desired: number) => number;
};

const applyBinary = async (
  transport: ActuatorTransport,
  command: Extract<DeviceCommand, { kind: 'binary' }>,
): Promise<ActuatorOutcome> => {
  try {
    await transport.requestBinaryControl(command.deviceId, command.desired);
    return { requested: true, kind: 'binary', acknowledged: true };
  } catch (err) {
    if (!isHomeyRequestTimeout(err)) throw err;
    return { requested: true, kind: 'binary', acknowledged: false, err };
  }
};

const applyTarget = async (
  transport: ActuatorTransport,
  command: Extract<DeviceCommand, { kind: 'target' }>,
): Promise<ActuatorOutcome> => {
  const requestedTargetValue = await transport.requestTemperatureTarget(command.deviceId, command.value);
  return { requested: true, kind: 'target', requestedTargetValue };
};

const applyStep = async (
  transport: ActuatorTransport,
  command: Extract<DeviceCommand, { kind: 'step' }>,
): Promise<ActuatorOutcome> => {
  try {
    const result = await transport.requestSteppedLoadStep(command);
    return result.requested ? { kind: 'step', ...result } : result;
  } catch (error) {
    const err = error instanceof SteppedLoadTransportError ? error.cause : error;
    if (!isHomeyRequestTimeout(err)) throw error;
    return {
      requested: true, kind: 'step', acknowledged: false,
      transport: error instanceof SteppedLoadTransportError ? error.transport : 'native_capability',
      reasonCode: 'command_request_timed_out', err,
    };
  }
};

const applyStoragePower = async (
  transport: ActuatorTransport,
  command: Extract<DeviceCommand, { kind: 'storage_power' }>,
): Promise<ActuatorOutcome> => {
  const write = await transport.requestStoragePower(command);
  if (write.kind === 'claim_rejected') {
    return { requested: false, reason: write.kind, errorMessage: write.errorMessage };
  }
  return { requested: true, kind: 'storage_power', requestedSetpointW: write.setpointW };
};

const applyStorageRelease = async (
  transport: ActuatorTransport,
  command: Extract<DeviceCommand, { kind: 'storage_release' }>,
): Promise<ActuatorOutcome> => {
  await transport.releaseStorageControl(command);
  return { requested: true, kind: 'storage_release' };
};

const applyCommand = (transport: ActuatorTransport, command: DeviceCommand): Promise<ActuatorOutcome> => {
  switch (command.kind) {
    case 'binary':
      return applyBinary(transport, command);
    case 'target':
      return applyTarget(transport, command);
    case 'step':
      return applyStep(transport, command);
    case 'storage_power':
      return applyStoragePower(transport, command);
    case 'storage_release':
      return applyStorageRelease(transport, command);
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
};

/**
 * Build an {@link Actuator} bound to an injected transport write surface. Wiring
 * (`setup/**`) supplies the transport; the actuator layer never imports
 * `lib/device/**` itself.
 */
export const createDeviceActuator = (transport: ActuatorTransport): Actuator => ({
  canTurnOnDevice: (deviceId) => transport.canTurnOnDevice(deviceId),
  apply: (command) => applyCommand(transport, command),
  resolveTemperatureTarget: (deviceId, desired) => transport.resolveTemperatureTarget(deviceId, desired),
});
