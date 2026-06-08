import { callApi } from './homey.ts';
import {
  SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
  type SettingsUiDeferredObjectivePlanHistoryPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../contracts/src/deferredObjectivePlanHistory.ts';

export type DeadlinePlanHistoryView = {
  entries: ResolvedDeferredObjectivePlanHistoryEntry[];
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
  // When `true`, propagate API failures to the caller instead of degrading to
  // an empty list. The live deadline-plan route (where History is a secondary
  // tab) swallows so a transient backend hiccup doesn't blank the page; the
  // history-detail route opts in so it can distinguish a real "entry rolled
  // off" miss from a transient fetch failure.
  throwOnError = false,
): Promise<DeadlinePlanHistoryView> => {
  if (!deviceId) return { entries: [], timeZone };
  try {
    const payload = await callApi<SettingsUiDeferredObjectivePlanHistoryPayload>(
      'GET',
      SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
    );
    return { entries: payload.entriesByDeviceId[deviceId] ?? [], timeZone };
  } catch (error) {
    if (throwOnError) throw error;
    return { entries: [], timeZone };
  }
};
