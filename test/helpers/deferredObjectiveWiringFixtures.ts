import type { ResolveObjectiveDeviceExclusion } from '../../lib/objectives/deferredObjectives/deviceExclusion';
import type { DeferredObjectiveStallClassificationReader } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { createDeferredObjectiveEndedBus } from '../../lib/objectives/deferredObjectives/endedEventBus';
import type { PlanHistoryPersistDeps } from '../../lib/objectives/deferredObjectives/planHistory';

// Live-wiring inputs every smart-task allocation takes, answered the way a
// single main home with no parked device answers them.

/** Every device is in the main planning lane and managed by PELS. */
export const noDeviceExclusion: ResolveObjectiveDeviceExclusion = () => null;

/** No device is parked at its target. */
export const noStallEvidence: DeferredObjectiveStallClassificationReader = () => undefined;

/**
 * The plan-history recorder's live collaborators, answered inertly: no ended-run
 * listener, no price data, debug output discarded, no device parked at its
 * target. Spread under a spec's own `load`/`save`.
 */
export const inertPlanHistoryDeps = (): Pick<
  PlanHistoryPersistDeps,
  'endedBus' | 'resolveHourPrice' | 'debugStructured' | 'getStallClassification'
> => ({
  endedBus: createDeferredObjectiveEndedBus(),
  resolveHourPrice: () => null,
  debugStructured: () => undefined,
  getStallClassification: noStallEvidence,
});
