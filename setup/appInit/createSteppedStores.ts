import {
  createSteppedCommandStore,
  type SteppedCommandStore,
} from '../../lib/executor/steppedCommandStore';
import {
  createSteppedReportedStepStore,
  type SteppedReportedStepStore,
} from '../../lib/observer/steppedReportedStep';
import { ControlContestRecord } from '../../lib/executor/controlContest';
import { createDeferredDeviceJournal } from '../../lib/diagnostics/deviceEventStore';
import type { UserdataDatabase } from '../../lib/store/userdataDatabase';

export type SteppedStores = {
  /** What PELS commanded: the executor's axis. */
  commandStore: SteppedCommandStore;
  /** What the device attested over Flow: the observer's axis. */
  reportedStore: SteppedReportedStepStore;
  /** The executor's drift corrections, which the command store reports confirmations and ended sessions to. */
  controlContests: ControlContestRecord;
};

/**
 * Build the two stepped-load stores and wire them the one way round they go:
 * the executor is handed the observation to reconcile its commands against, and
 * never the reverse.
 *
 * They are constructed together because that relationship is fixed, and here
 * rather than in `app.ts` because construction is setup's job — `app.ts` holds
 * the result. Device ids are globally unique, so one pair serves every home.
 * The contest record is built with them because the command store reports to
 * it from construction: which step commands the device confirmed, and which
 * command sessions ended. Every home's execution state shares it too.
 */
export const createSteppedStores = (getUserdataDatabase: () => UserdataDatabase): SteppedStores => {
  const reportedStore = createSteppedReportedStepStore();
  // Built with the app, before the userdata database opens.
  const controlContests = new ControlContestRecord(createDeferredDeviceJournal(getUserdataDatabase));
  return {
    commandStore: createSteppedCommandStore(reportedStore, controlContests),
    reportedStore,
    controlContests,
  };
};
