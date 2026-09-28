import type { ResolveObjectiveDeviceExclusion } from '../../lib/objectives/deferredObjectives/deviceExclusion';
import type { DeferredObjectiveStallClassificationReader } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { createDeferredObjectiveEndedBus } from '../../lib/objectives/deferredObjectives/endedEventBus';
import type { PlanHistoryPersistDeps } from '../../lib/objectives/deferredObjectives/planHistory';
import {
  EnergyTaskDeliveryTracker,
  type DeliveredEnergyReader,
  type EnergyDeliveryRun,
  type EnergyDeliveryStore,
} from '../../lib/objectives/deferredObjectives/energyDelivery';

// Live-wiring inputs every smart-task allocation takes, answered the way a
// single main home with no parked device answers them.

/** Every device is in the main planning lane and managed by PELS. */
export const noDeviceExclusion: ResolveObjectiveDeviceExclusion = () => null;

/** No device is parked at its target. */
export const noStallEvidence: DeferredObjectiveStallClassificationReader = () => undefined;

/** No energy task has fed its device anything yet. */
export const noDeliveredEnergy: DeliveredEnergyReader = () => 0;

/** An energy-delivery store held in memory, with the rows it was last given. */
export const createMemoryEnergyDeliveryStore = (
  initial: readonly EnergyDeliveryRun[] = [],
): EnergyDeliveryStore & { rows: () => readonly EnergyDeliveryRun[] } => {
  let rows: readonly EnergyDeliveryRun[] = initial.map((run) => ({ ...run }));
  return {
    read: () => rows.map((run) => ({ ...run })),
    write: (runs) => { rows = runs.map((run) => ({ ...run })); },
    rows: () => rows,
  };
};

/** Every power reading is a live measurement. */
export const everyReadingLive = (): boolean => true;

/** A delivery tracker over an empty in-memory store. */
export const createInertEnergyDelivery = (): EnergyTaskDeliveryTracker => (
  new EnergyTaskDeliveryTracker(createMemoryEnergyDeliveryStore(), everyReadingLive)
);

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
