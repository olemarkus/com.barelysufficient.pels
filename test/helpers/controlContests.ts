import type { DeviceJournalEvent } from '../../lib/ports/deviceJournal';
import { ControlContestRecord } from '../../lib/executor/controlContest';

/** A contest record whose journal keeps what it was given, as production's device journal does. */
export const controlContestsForTest = () => {
  const journalled: { deviceIds: readonly string[]; event: DeviceJournalEvent }[] = [];
  const contests = new ControlContestRecord({ record: (deviceIds, event) => { journalled.push({ deviceIds, event }); } });
  return { contests, journalled };
};
