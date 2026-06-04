import type { AppContext } from '../../lib/app/appContext';
import { createDeviceActuator, type Actuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';
import { resolveFlowBackedBinaryTriggerCardId } from '../../lib/executor/planExecutorPredicates';

// Single definition of the flow-backed binary trigger so production wiring and
// tests resolve the SAME trigger card — no hand-copied closure that can drift.
// Throws when the card is unavailable: a flow-backed binary must never silently
// no-op (a direct setCapability would, leaving the load on).
export const makeFlowBackedBinaryTrigger = (
  flow: AppContext['homey']['flow'],
) => async (
  deviceId: string,
  capabilityId: 'onoff' | 'evcharger_charging',
  desired: boolean,
): Promise<void> => {
  const triggerCardId = resolveFlowBackedBinaryTriggerCardId(capabilityId, desired);
  const triggerCard = flow?.getTriggerCard?.(triggerCardId);
  if (!triggerCard?.trigger) throw new Error(`Flow trigger ${triggerCardId} is unavailable`);
  await triggerCard.trigger({}, { deviceId });
};

// Compose the device actuator from app wiring: the device-manager writes plus a
// flow-backed binary control trigger (Homey Flow card) for devices whose binary
// capability is flow-backed. Transport stays the sole SDK owner; this wraps it as
// the injected write surface behind the actuator seam. Reachable from app wiring
// without the plan→executor actuation surface, so both the terminal-shed lifecycle
// and the plan executor can route their writes through one actuator.
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
  return createDeviceActuator(actuatorTransport);
};
