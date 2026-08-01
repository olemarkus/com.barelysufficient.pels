import { isFiniteNumber } from '../lib/utils/appTypeGuards';
import type { CapacityShortfallSustainedCrossing } from '../setup/capacityShortfallAlertDispatch';
import { readFlowNumberArg } from './flowArgParsers';
import type { FlowCardDeps } from './registerFlowCards';

/**
 * Narrow the Flow `state` Homey hands back to the crossing the dispatcher put
 * in. The producer types the payload, so this is the one SDK-boundary guard
 * rather than a per-field hedge — and an unreadable crossing refuses instead of
 * matching, because the alternative would let every 10 s grid step of an
 * incident fire the same Flow.
 */
const asCrossing = (state: unknown): CapacityShortfallSustainedCrossing | null => {
  if (typeof state !== 'object' || state === null) return null;
  const { sustainedSeconds, previousSustainedSeconds } = (
    state as Partial<CapacityShortfallSustainedCrossing>
  );
  if (!isFiniteNumber(sustainedSeconds) || !isFiniteNumber(previousSustainedSeconds)) return null;
  return { sustainedSeconds, previousSustainedSeconds };
};

/**
 * `capacity_shortfall_sustained` — "hard cap breach imminent for at least X
 * seconds".
 *
 * The runtime cannot know which durations users configured, so
 * `setup/capacityShortfallAlertDispatch.ts` emits a crossing on every step of
 * its 10 s grid and this listener decides which saved Flows match. Same shape
 * as `smart_task_hours_remaining`'s listener, though the trigger call itself
 * lives in `setup/` because the dispatcher is per-home: the two sides share
 * `CapacityShortfallSustainedCrossing` so the payload still has one owner.
 *
 * The arg-less `capacity_shortfall` card is deliberately absent here — with no
 * args there is nothing to filter, so it keeps Homey's default listener.
 */
export function registerCapacityShortfallSustainedTrigger(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getTriggerCard('capacity_shortfall_sustained');
  card.registerRunListener(async (args: unknown, state?: unknown) => {
    const threshold = readFlowNumberArg(args, 'seconds');
    if (threshold === null) return false;
    const crossing = asCrossing(state);
    if (crossing === null) return false;
    // Fire only on the grid step where the breach first reaches this Flow's
    // threshold. `previousSustainedSeconds` is the dispatcher's high-water mark
    // for the incident, so an already crossed threshold stays quiet even though
    // later steps keep arriving for Flows set to a longer duration.
    return crossing.previousSustainedSeconds < threshold && threshold <= crossing.sustainedSeconds;
  });
}
