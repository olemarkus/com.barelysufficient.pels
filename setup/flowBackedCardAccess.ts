import type Homey from 'homey';
import {
  FlowBackedDeviceState,
  type FlowBackedDeviceStateDeps,
} from '../lib/device/flowBackedDeviceState';
import type { FlowBackedRefreshTrigger } from '../lib/device/flowBackedRefreshTrigger';

const REFRESH_REQUESTED_CARD_ID = 'flow_backed_device_refresh_requested';

/**
 * The SDK side of the device layer's Flow-card seams.
 *
 * `homey.flow` and its methods can each be absent — an older firmware, a
 * partial test double — and `getActionCard`/`getTriggerCard` throw for a card
 * this environment does not have. Every one of those means the same thing to a
 * consumer ("that card is not available here"), so all of them are classified
 * here and none of them reach `lib/device`.
 */
const isFlowCardAvailable = (
  homey: Homey.App['homey'],
  kind: 'action' | 'trigger',
  cardId: string,
): boolean => {
  try {
    return kind === 'action'
      ? Boolean(homey.flow?.getActionCard?.(cardId))
      : Boolean(homey.flow?.getTriggerCard?.(cardId));
  } catch {
    return false;
  }
};

const resolveFlowBackedRefreshTrigger = (
  homey: Homey.App['homey'],
): FlowBackedRefreshTrigger => {
  try {
    const card = homey.flow?.getTriggerCard?.(REFRESH_REQUESTED_CARD_ID);
    if (!card?.trigger) return { state: 'unavailable' };
    return {
      state: 'available',
      trigger: (state) => card.trigger({}, state),
    };
  } catch {
    return { state: 'unavailable' };
  }
};

/**
 * Build the flow-backed device state with its Homey-facing seams resolved.
 *
 * The component itself is a `lib/device` component and names no SDK type; this
 * factory is the only place that knows the two Flow-card lookups above exist,
 * which is the whole point of the split.
 */
export const createFlowBackedDeviceState = (
  homey: Homey.App['homey'],
  deps: Omit<FlowBackedDeviceStateDeps, 'isFlowCardAvailable' | 'getFlowBackedRefreshTrigger'>,
): FlowBackedDeviceState => new FlowBackedDeviceState({
  ...deps,
  isFlowCardAvailable: (kind, cardId) => isFlowCardAvailable(homey, kind, cardId),
  getFlowBackedRefreshTrigger: () => resolveFlowBackedRefreshTrigger(homey),
});
