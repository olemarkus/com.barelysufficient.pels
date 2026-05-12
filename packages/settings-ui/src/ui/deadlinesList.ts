import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
  SETTINGS_UI_DEVICES_PATH,
  type SettingsUiBootstrap,
  type SettingsUiDeferredObjectivePlanHistoryPayload,
  type SettingsUiDevicesPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import {
  normalizeDeferredObjectiveSettings,
  type DeferredObjectiveSettingsV1,
} from '../../../contracts/src/deferredObjectiveSettings.ts';
import type {
  DeferredObjectiveActivePlansV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { DeferredObjectivePlanHistoryEntry } from '../../../contracts/src/deferredObjectivePlanHistory.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { buildDeadlineHref } from './deadlineUrls.ts';
import { resolveBrowserTimeZone } from './deadlinePlanHistoryFetch.ts';
import {
  renderDeadlinesList,
  type DeadlinesListCard,
  type DeadlinesListState,
} from './views/DeadlinesList.tsx';
import {
  renderDeadlinesHistoryList,
  type DeadlinesHistoryListState,
} from './views/DeadlinesHistoryList.tsx';

const isObjectiveEnabled = (
  settings: DeferredObjectiveSettingsV1,
  deviceId: string,
): boolean => Boolean(settings.objectivesByDeviceId[deviceId]?.enabled);

export const resolveDeadlinesListCards = (params: {
  activePlans: DeferredObjectiveActivePlansV1 | null;
  objectiveSettings: DeferredObjectiveSettingsV1;
  devices: readonly TargetDeviceSnapshot[];
}): DeadlinesListCard[] => {
  const plans = params.activePlans?.plansByDeviceId ?? {};
  const deviceNamesById = new Map(params.devices.map((device) => [device.id, device.name]));
  const cards: DeadlinesListCard[] = [];
  for (const [deviceId, plan] of Object.entries(plans)) {
    if (!isObjectiveEnabled(params.objectiveSettings, deviceId)) continue;
    const pending = plan.pending || plan.latest === null;
    const firstHour = plan.latest?.hours[0]?.startsAtMs ?? null;
    cards.push({
      deviceId,
      deviceName: deviceNamesById.get(deviceId) ?? plan.deviceName ?? deviceId,
      kind: plan.objectiveKind,
      targetTemperatureC: plan.targetTemperatureC,
      targetPercent: plan.targetPercent,
      createdAtMs: plan.startedAtMs,
      firstActionAtMs: firstHour,
      deadlineAtMs: plan.deadlineAtMs,
      href: buildDeadlineHref(deviceId),
      pending,
    });
  }
  cards.sort((a, b) => a.deadlineAtMs - b.deadlineAtMs);
  return cards;
};

export const resolveDeadlinesHistoryEntries = (
  payload: SettingsUiDeferredObjectivePlanHistoryPayload | null,
): DeferredObjectivePlanHistoryEntry[] => {
  if (!payload) return [];
  return Object.values(payload.entriesByDeviceId)
    .flat()
    .sort((a, b) => b.finalizedAtMs - a.finalizedAtMs);
};

const getSurface = (): HTMLElement | null => (
  document.getElementById('deadlines-list-root')
);

const getHistorySurface = (): HTMLElement | null => (
  document.getElementById('deadlines-history-root')
);

const fetchPlanHistoryOrNull = async (): Promise<
  SettingsUiDeferredObjectivePlanHistoryPayload | null
> => {
  try {
    return await callApi<SettingsUiDeferredObjectivePlanHistoryPayload>(
      'GET',
      SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
    );
  } catch {
    return null;
  }
};

const renderHistorySurface = (
  surface: HTMLElement,
  payload: SettingsUiDeferredObjectivePlanHistoryPayload | null,
): void => {
  const entries = resolveDeadlinesHistoryEntries(payload);
  const state: DeadlinesHistoryListState = entries.length === 0
    ? { status: 'hidden' }
    : { status: 'ready', entries, timeZone: resolveBrowserTimeZone() };
  renderDeadlinesHistoryList(surface, state);
};

export const refreshDeadlinesList = async (): Promise<void> => {
  const surface = getSurface();
  if (!surface) return;
  const historySurface = getHistorySurface();
  renderDeadlinesList(surface, { status: 'loading' });
  if (historySurface) renderDeadlinesHistoryList(historySurface, { status: 'loading' });
  // Fire history fetch in parallel but don't await it before rendering the
  // active list — history is optional and a slow/hanging endpoint must not
  // gate first paint of the primary Smart tasks list.
  if (historySurface) {
    const targetSurface = historySurface;
    void fetchPlanHistoryOrNull().then((payload) => {
      renderHistorySurface(targetSurface, payload);
    });
  }
  try {
    const [bootstrap, devicesPayload] = await Promise.all([
      callApi<SettingsUiBootstrap>('GET', SETTINGS_UI_BOOTSTRAP_PATH),
      callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH),
    ]);
    const objectiveSettings = normalizeDeferredObjectiveSettings(
      bootstrap.settings.deferred_objectives,
    );
    const cards = resolveDeadlinesListCards({
      activePlans: bootstrap.deferredObjectiveActivePlans,
      objectiveSettings,
      devices: devicesPayload.devices,
    });
    const state: DeadlinesListState = { status: 'ready', cards };
    renderDeadlinesList(surface, state);
  } catch (error) {
    await logSettingsError('Failed to load deadlines list', error, 'refreshDeadlinesList');
    renderDeadlinesList(surface, {
      status: 'error',
      message: 'Could not load smart tasks. Try again later.',
    });
  }
};

export const testExports = {
  resolveDeadlinesListCards,
  resolveDeadlinesHistoryEntries,
};
