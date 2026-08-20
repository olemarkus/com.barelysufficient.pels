import type { BinaryControlCapabilityId } from '../../packages/contracts/src/types';
import type { AppContext } from '../../lib/app/appContext';
import { createDeviceActuator, type Actuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorTransport, DeviceCommand } from '../../lib/actuator/deviceCommand';
import { resolveFlowBackedBinaryTriggerCardId } from '../../flowCards/flowBackedDeviceCards';

// Single definition of the flow-backed binary trigger so production wiring and
// tests resolve the SAME trigger card — no hand-copied closure that can drift.
// Throws when the card is unavailable: a flow-backed binary must never silently
// no-op (a direct setCapability would, leaving the load on).
export const makeFlowBackedBinaryTrigger = (
  flow: AppContext['homey']['flow'],
) => async (
  deviceId: string,
  capabilityId: BinaryControlCapabilityId,
  desired: boolean,
): Promise<void> => {
  const triggerCardId = resolveFlowBackedBinaryTriggerCardId(capabilityId, desired);
  const triggerCard = flow?.getTriggerCard?.(triggerCardId);
  if (!triggerCard?.trigger) throw new Error(`Flow trigger ${triggerCardId} is unavailable`);
  await triggerCard.trigger({}, { deviceId });
};

/**
 * The one command family the fence governs: a command that would reach the
 * `target_temperature` capability. Binary and stepped commands drive different
 * axes of the device and are none of this setting's business — fencing `step`
 * here made the planner believe it had trimmed a stepped device while the
 * actuator silently swallowed the command as `{ requested: false }`.
 */
const isTemperatureTargetCommand = (command: DeviceCommand): boolean => (
  command.kind === 'target' && command.target === 'temperature'
);

/**
 * Live point-of-use authorization fence for "Disable temperature control".
 * Binary and stepped capacity control remain available; a setpoint write is
 * refused before it reaches transport, including stale retries and lifecycle
 * fallback.
 */
export const createTemperatureControlFencedActuator = (
  base: Actuator,
  shouldFence: (command: DeviceCommand) => boolean,
): Actuator => ({
  resolveTemperatureTarget: base.resolveTemperatureTarget.bind(base),
  apply: (command) => (
    isTemperatureTargetCommand(command) && shouldFence(command)
      ? Promise.resolve({ requested: false })
      : base.apply(command)
  ),
});

const shouldFenceTemperatureCommand = (ctx: AppContext, command: DeviceCommand): boolean => (
  ctx.isTemperatureControlDisabled(command.deviceId)
  // A queued setpoint can outlive its source snapshot. While the cold-boot
  // policy remains unavailable, the command's own temperature target still
  // identifies it as temperature control even if the device has disappeared
  // from the current snapshot.
  || ctx.temperatureControlPolicyState === 'unavailable'
);

// Compose the device actuator from app wiring: the device-manager writes plus a
// flow-backed binary control trigger (Homey Flow card) for devices whose binary
// capability is flow-backed. Transport stays the sole SDK owner; this wraps it as
// the injected write surface behind the actuator seam. Reachable from app wiring
// without a planner-owned write path, so both lifecycle fallback and ordinary
// plan execution route their writes through one actuator.
//
// Returns null when the device manager is absent (startup / snapshot flicker) so
// callers can guard before actuating.
export const buildDeviceActuator = (ctx: AppContext): Actuator | null => {
  const transport = ctx.deviceManager;
  if (!transport) return null;
  const actuatorTransport: ActuatorTransport = {
    requestBinaryControl: (deviceId, desired) => transport.requestBinaryControl(
      deviceId,
      desired,
      makeFlowBackedBinaryTrigger(ctx.homey.flow),
    ),
    requestTemperatureTarget: (deviceId, desired) => transport.requestTemperatureTarget(deviceId, desired),
    resolveTemperatureTarget: (deviceId, desired) => transport.resolveTemperatureTarget(deviceId, desired),
    requestSteppedLoadStep: transport.requestSteppedLoadStep.bind(transport),
  };
  return createTemperatureControlFencedActuator(
    createDeviceActuator(actuatorTransport),
    (command) => shouldFenceTemperatureCommand(ctx, command),
  );
};
