import type { ControlContestOccurrence } from '../../lib/ports/controlContest';
import type { DeviceJournalEvent } from '../../lib/ports/deviceJournal';
import { ControlContestRecord } from '../../lib/executor/controlContest';

/** A contest record whose journal keeps what it was given, as production's device journal does. */
export const controlContestsForTest = (collectEvidence: (contest: ControlContestOccurrence) => void = () => undefined) => {
  const journalled: { deviceIds: readonly string[]; event: DeviceJournalEvent }[] = [];
  const contests = new ControlContestRecord({
    record: (deviceIds, event) => { journalled.push({ deviceIds, event }); },
  }, collectEvidence);
  return { contests, journalled };
};
