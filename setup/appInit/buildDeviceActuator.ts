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
 * Live point-of-use authorization fence for "Disable temperature control".
 * Binary capacity control remains available; every richer command is refused
 * before it reaches transport, including stale retries and lifecycle fallback.
 */
export const createTemperatureControlFencedActuator = (
  base: Actuator,
  shouldFence: (command: DeviceCommand) => boolean,
): Actuator => ({
  apply: (command) => (
    command.kind !== 'binary' && shouldFence(command)
      ? Promise.resolve({ requested: false })
      : base.apply(command)
  ),
});

const shouldFenceTemperatureCommand = (ctx: AppContext, command: DeviceCommand): boolean => {
  if (command.kind === 'binary') return false;
  if (ctx.isTemperatureControlDisabled(command.deviceId)) return true;
  // A queued target can outlive its source snapshot. While the cold-boot policy
  // remains unavailable, its capability still identifies it as temperature
  // control even if the device has disappeared from the current snapshot.
  return ctx.temperatureControlPolicyState === 'unavailable'
    && command.kind === 'target'
    && (
      command.targetKind === 'temperature'
      || command.capabilityId?.startsWith('target_temperature') === true
    );
};

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
  // Bind so the optional stepped wrapper keeps its DeviceTransport receiver, then
  // spread the bound fn straight onto the surface (no Parameters<...> wrapper needed).
  const requestSteppedLoadStep = transport.requestSteppedLoadStep?.bind(transport);
  const actuatorTransport: ActuatorTransport = {
    setCapability: (deviceId, capabilityId, value) => transport.setCapability(deviceId, capabilityId, value),
    applyDeviceTargets: (targets, contextInfo) => transport.applyDeviceTargets(targets, contextInfo),
    // `=== undefined` (not truthiness): the type says it's always defined, but tests pass a
    // partial deviceManager without it, so the runtime guard is real.
    ...(requestSteppedLoadStep === undefined ? {} : { requestSteppedLoadStep }),
    triggerFlowBackedBinaryControl: makeFlowBackedBinaryTrigger(ctx.homey.flow),
  };
  return createTemperatureControlFencedActuator(
    createDeviceActuator(actuatorTransport),
    (command) => shouldFenceTemperatureCommand(ctx, command),
  );
};
