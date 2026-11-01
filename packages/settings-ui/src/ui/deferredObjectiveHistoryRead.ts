import type {
  SettingsUiDeferredObjectivePlanHistoryPayload,
} from '../../../contracts/src/deferredObjectivePlanHistory.ts';
import { SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { callApi } from './homey.ts';

type HistoryReader = 'overview' | 'recommendations';
let historyRead: {
  read: Promise<SettingsUiDeferredObjectivePlanHistoryPayload>;
  readers: Set<HistoryReader>;
} | undefined;

// Overview and setup suggestions need the same archive during startup. Share
// only the outstanding read: a later visit must see runs that have since ended.
// Repeated refreshes from the same owner deliberately start a newer read,
// preserving that owner's last-wins behavior when a refresh overtakes another.
export const readDeferredObjectiveHistory = (
  reader: HistoryReader,
): Promise<SettingsUiDeferredObjectivePlanHistoryPayload> => {
  if (historyRead && !historyRead.readers.has(reader)) {
    historyRead.readers.add(reader);
    return historyRead.read;
  }
  const read = callApi<SettingsUiDeferredObjectivePlanHistoryPayload>(
    'GET', SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
  ).finally(() => {
    if (historyRead?.read === read) historyRead = undefined;
  });
  historyRead = { read, readers: new Set([reader]) };
  return read;
};

// A task change can finalize a run while an older read is still outstanding.
// New readers must not join that read; existing consumers retain their own
// generation guards, and its settlement must not clear the replacement read.
export const invalidateDeferredObjectiveHistoryRead = (): void => {
  historyRead = undefined;
};
