import {
  createSteppedCommandStore,
  type SteppedCommandStore,
} from '../../lib/executor/steppedCommandStore';
import {
  createSteppedReportedStepStore,
  type SteppedReportedStepStore,
} from '../../lib/observer/steppedReportedStep';

export type SteppedStores = {
  /** What PELS commanded: the executor's axis. */
  commandStore: SteppedCommandStore;
  /** What the device attested over Flow: the observer's axis. */
  reportedStore: SteppedReportedStepStore;
};

/**
 * Build the two stepped-load stores and wire them the one way round they go:
 * the executor is handed the observation to reconcile its commands against, and
 * never the reverse.
 *
 * They are constructed together because that relationship is fixed, and here
 * rather than in `app.ts` because construction is setup's job — `app.ts` holds
 * the result. Device ids are globally unique, so one pair serves every home.
 */
export const createSteppedStores = (): SteppedStores => {
  const reportedStore = createSteppedReportedStepStore();
  return { commandStore: createSteppedCommandStore(reportedStore), reportedStore };
};
