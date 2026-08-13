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
  apply: (command: DeviceCommand) => Promise<ActuatorOutcome>;
  resolveTemperatureTarget: (deviceId: string, desired: number) => number;
};

const applyBinary = async (
  transport: ActuatorTransport,
  command: Extract<DeviceCommand, { kind: 'binary' }>,
): Promise<ActuatorOutcome> => {
  await transport.requestBinaryControl(command.deviceId, command.desired);
  return { requested: true, kind: 'binary' };
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
  // Invoke on `transport` directly so a class-method implementation keeps its
  // `this` receiver (don't detach into a local const).
  const result = await transport.requestSteppedLoadStep({
    deviceId: command.deviceId,
    profile: command.profile,
    desiredStepId: command.desiredStepId,
    planningPowerW: command.planningPowerW,
    planningCurrentA: command.planningCurrentA,
    previousStepId: command.previousStepId,
  });
  if (!result.requested) return { requested: false };
  return { requested: true, kind: 'step', steppedResult: result };
};

const applyCommand = (transport: ActuatorTransport, command: DeviceCommand): Promise<ActuatorOutcome> => {
  switch (command.kind) {
    case 'binary':
      return applyBinary(transport, command);
    case 'target':
      return applyTarget(transport, command);
    case 'step':
      return applyStep(transport, command);
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
  apply: (command) => applyCommand(transport, command),
  resolveTemperatureTarget: (deviceId, desired) => transport.resolveTemperatureTarget(deviceId, desired),
});
