import { callApi } from './homey.ts';
import {
  SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
  type SettingsUiDeferredObjectivePlanHistoryPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import type { DeferredObjectivePlanHistoryEntry } from '../../../contracts/src/deferredObjectivePlanHistory.ts';

export type DeadlinePlanHistoryView = {
  entries: DeferredObjectivePlanHistoryEntry[];
  timeZone: string;
};

export const resolveBrowserTimeZone = (): string => (
  typeof Intl !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
    : 'UTC'
);

export const fetchDeadlinePlanHistory = async (
  deviceId: string | null,
  timeZone: string,
): Promise<DeadlinePlanHistoryView> => {
  if (!deviceId) return { entries: [], timeZone };
  try {
    const payload = await callApi<SettingsUiDeferredObjectivePlanHistoryPayload>(
      'GET',
      SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
    );
    return { entries: payload.entriesByDeviceId[deviceId] ?? [], timeZone };
  } catch {
    return { entries: [], timeZone };
  }
};
