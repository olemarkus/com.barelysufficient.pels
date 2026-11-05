import type {
  LifecycleFallbackDevice, LifecycleFallbackObservedState,
} from '../lib/executor/lifecycleFallbackDispatcher';
import { buildLifecycleFallbackRequest } from '../lib/executor/lifecycleFallbackRequest';
import { resolveFallbackPosture } from '../lib/planInput/lifecycleFallbackPosture';

/** Connect input-owned posture selection to executor-owned request construction. */
export const resolveLifecycleFallbackRequest = (
  device: LifecycleFallbackDevice,
  observedState: LifecycleFallbackObservedState,
  configuredFallback: Parameters<typeof resolveFallbackPosture>[1],
) => buildLifecycleFallbackRequest(
  device, observedState, resolveFallbackPosture(device, configuredFallback),
);
