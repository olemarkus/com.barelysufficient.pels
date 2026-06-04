import type { ActuatorOutcome, ActuatorTransport, DeviceCommand } from './deviceCommand';

/**
 * The single write seam. Every device write the runtime issues flows through an
 * `Actuator`: it translates a channel-blind {@link DeviceCommand} onto transport's
 * capability/channel writes, and is the only place that maps intent → SDK call.
 *
 * It owns *mechanism* only — the intent→channel mapping, including routing a
 * binary command to a Flow trigger vs a direct capability write on the
 * producer-resolved `flowBacked` flag. It owns no *policy*: cooldowns live in
 * `lib/plan`, idempotency/evidence gating lives in the caller, settle/pending
 * bookkeeping is transport-opened and observer-resolved.
 *
 * See `notes/state-management/actuator-write-seam.md`.
 */
export type Actuator = {
  apply: (command: DeviceCommand) => Promise<ActuatorOutcome>;
};

const applyBinary = async (
  transport: ActuatorTransport,
  command: Extract<DeviceCommand, { kind: 'binary' }>,
): Promise<ActuatorOutcome> => {
  if (command.flowBacked) {
    // Flow-backed device: a direct setCapability would silently no-op and leave
    // the load on. Fire the device's flow-backed control request instead.
    await transport.triggerFlowBackedBinaryControl(command.deviceId, command.control, command.desired);
  } else {
    await transport.setCapability(command.deviceId, command.control, command.desired);
  }
  return { requested: true };
};

const applyTarget = async (
  transport: ActuatorTransport,
  command: Extract<DeviceCommand, { kind: 'target' }>,
): Promise<ActuatorOutcome> => {
  if (command.capabilityId !== undefined) {
    // Single addressed setpoint: write the capability directly so a failure
    // propagates to the caller's retry/pending path (don't swallow it).
    await transport.setCapability(command.deviceId, command.capabilityId, command.value);
    return { requested: true };
  }
  await transport.applyDeviceTargets({ [command.deviceId]: command.value }, command.contextInfo);
  return { requested: true };
};

const applyStep = async (
  transport: ActuatorTransport,
  command: Extract<DeviceCommand, { kind: 'step' }>,
): Promise<ActuatorOutcome> => {
  if (!transport.requestSteppedLoadStep) return { requested: false };
  // Invoke on `transport` directly so a class-method implementation keeps its
  // `this` receiver (don't detach into a local const).
  const result = await transport.requestSteppedLoadStep({
    deviceId: command.deviceId,
    profile: command.profile,
    desiredStepId: command.desiredStepId,
    planningPowerW: command.planningPowerW,
    planningCurrentA: command.planningCurrentA,
    actuationMode: command.actuationMode,
    previousStepId: command.previousStepId,
  });
  return { requested: result.requested, steppedResult: result };
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
});
