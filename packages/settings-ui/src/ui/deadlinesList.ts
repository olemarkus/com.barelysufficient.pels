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
  ResolvedDeferredObjectiveActivePlansV1,
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../contracts/src/deferredObjectivePlanHistory.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { buildDeadlineHref } from './deadlineUrls.ts';
import { resolveBrowserTimeZone } from './deadlinePlanHistoryFetch.ts';
import {
  formatSmartTaskExtraPermissionsValue,
  formatSmartTaskCurrentValueLine,
  resolveChipConfidence,
  resolveSmartTaskLearning,
  resolveSmartTaskListStatus,
  SMART_TASK_LIST_LOAD_ERROR_COPY,
} from '../../../shared-domain/src/deadlineLabels.ts';
import {
  renderDeadlinesList,
  type DeadlinesListCard,
  type DeadlinesListState,
} from './views/DeadlinesList.tsx';
import {
  renderDeadlinesHistoryList,
  type DeadlinesHistoryListState,
} from './views/DeadlinesHistoryList.tsx';

// Resolves the device's current value (current temperature for thermal kinds,
// state-of-charge for EV) by deviceId. Returns `null` when the value is not
// reported — the chip + currently-X line are then suppressed at the renderer.
//
// Looked up by device id rather than plumbed through the plan because the
// active-plan recorder doesn't carry live device readings; the snapshot
// fetched from `/ui_devices` (Homey SDK) does.
const resolveCurrentValue = (
  device: TargetDeviceSnapshot | undefined,
  kind: ResolvedDeferredObjectiveActivePlanV1['objectiveKind'],
): number | null => {
  if (!device) return null;
  if (kind === 'temperature') {
    return typeof device.currentTemperature === 'number' && Number.isFinite(device.currentTemperature)
      ? device.currentTemperature
      : null;
  }
  const percent = device.stateOfCharge?.percent;
  return typeof percent === 'number' && Number.isFinite(percent) ? percent : null;
};

const buildCard = (params: {
  deviceId: string;
  plan: ResolvedDeferredObjectiveActivePlanV1;
  objective: DeferredObjectiveSettingsV1['objectivesByDeviceId'][string] | undefined;
  device: TargetDeviceSnapshot | undefined;
  nowMs: number;
}): DeadlinesListCard => {
  const { deviceId, plan, objective, device, nowMs } = params;
  const pending = plan.pending || plan.latest === null;
  const firstHour = plan.latest?.hours[0]?.startsAtMs ?? null;
  const statusId = resolveSmartTaskListStatus({
    pending,
    pendingReason: plan.pendingReason,
    diagnosticReasonCode: plan.diagnosticReasonCode,
    planStatus: plan.latest?.planStatus,
    firstActionAtMs: firstHour,
    nowMs,
  });
  // Mirror the hero's chip-confidence chain (see `resolveEnergyNeededKWh` in
  // `deadlinePlanResolvers.ts`); `profileConfidence: null` collapses the
  // live-profile step since the list doesn't load `objectiveProfiles`.
  const confidence = resolveChipConfidence({
    provenance: plan.kwhPerUnitProvenance,
    profileConfidence: null,
  });
  const learning = resolveSmartTaskLearning(plan.kwhPerUnitProvenance);
  const currentValue = resolveCurrentValue(device, plan.objectiveKind);
  return {
    deviceId,
    deviceName: device?.name ?? plan.deviceName ?? deviceId,
    kind: plan.objectiveKind,
    targetValue: plan.targetValue,
    firstActionAtMs: firstHour,
    deadlineAtMs: plan.deadlineAtMs,
    href: buildDeadlineHref(deviceId),
    statusId,
    confidence,
    learning,
    extraPermissionsValue: formatSmartTaskExtraPermissionsValue(objective?.rescue),
    currentValueLine: formatSmartTaskCurrentValueLine({
      kind: plan.objectiveKind,
      currentValue,
    }),
  };
};

export const resolveDeadlinesListCards = (params: {
  activePlans: ResolvedDeferredObjectiveActivePlansV1 | null;
  objectiveSettings: DeferredObjectiveSettingsV1;
  devices: readonly TargetDeviceSnapshot[];
  nowMs?: number;
}): DeadlinesListCard[] => {
  const nowMs = params.nowMs ?? Date.now();
  const plans = params.activePlans?.plansByDeviceId ?? {};
  const devicesById = new Map(params.devices.map((device) => [device.id, device]));
  const cards: DeadlinesListCard[] = [];
  for (const [deviceId, plan] of Object.entries(plans)) {
    const objective = params.objectiveSettings.objectivesByDeviceId[deviceId];
    if (!objective?.enabled) continue;
    cards.push(buildCard({ deviceId, plan, objective, device: devicesById.get(deviceId), nowMs }));
  }
  cards.sort((a, b) => a.deadlineAtMs - b.deadlineAtMs);
  return cards;
};

export const resolveDeadlinesHistoryEntries = (
  payload: SettingsUiDeferredObjectivePlanHistoryPayload | null,
): ResolvedDeferredObjectivePlanHistoryEntry[] => {
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

// Persisted-filter localStorage key for the past-tasks chip row. Namespaced
// under `pels.` so it can't collide with other Homey-shell consumers, and
// includes the surface ("smart-tasks.history") so future filters on adjacent
// surfaces (active list, usage day) can claim their own key without
// re-litigating this one.
const HISTORY_DEVICE_FILTER_STORAGE_KEY = 'pels.smart-tasks.history.deviceFilter';

// localStorage may be unavailable inside the Homey iframe (privacy mode,
// sandboxed contexts, SSR-style preact tests). The two helpers below swallow
// access errors so a missing/forbidden storage surface degrades to "no
// persistence" rather than crashing the panel render.
const readPersistedDeviceFilter = (): string | null => {
  try {
    const value = window.localStorage.getItem(HISTORY_DEVICE_FILTER_STORAGE_KEY);
    if (typeof value !== 'string' || value.length === 0) return null;
    return value;
  } catch {
    return null;
  }
};

const writePersistedDeviceFilter = (deviceId: string | null): void => {
  try {
    if (deviceId === null) {
      window.localStorage.removeItem(HISTORY_DEVICE_FILTER_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(HISTORY_DEVICE_FILTER_STORAGE_KEY, deviceId);
  } catch {
    // Storage write failures degrade to in-memory-only state; the chip row
    // still reflects the click for the current session.
  }
};

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

// In-memory mirror of the persisted filter. Persistent state lives in
// localStorage; this cache keeps the chip-click round-trip fast (no read on
// every render) and lets the test suite reset state per-case without driving
// the storage surface directly.
let activeDeviceFilter: string | null = null;
let activeDeviceFilterInitialized = false;

// Past-task cost meta lines (per-row `Cost ≈ X kr · Y kWh delivered` + the
// ISO-week divider roll-up) no longer thread a LIVE display here: each history
// entry carries the `costDisplay` (unit + divisor) it was RECORDED under, and
// the shared-domain formatters scale + label with that recorded display (legacy
// entries fall back to the recording-era øre/kr default). This keeps an archived
// figure correct after the user switches price scheme/currency — a Norway run
// recorded as 150 øre still reads `≈ 2 kr`, not `≈ 150 EUR`. See
// `resolveEntryCostDisplay` in `deferredPlanHistoryReceiptStrings.ts`.

const ensureDeviceFilterInitialized = (): void => {
  if (activeDeviceFilterInitialized) return;
  activeDeviceFilter = readPersistedDeviceFilter();
  activeDeviceFilterInitialized = true;
};

// Monotonic refresh generation. The active list and the (independently
// fetched) history archive resolve on their own schedules, and the history
// `.then` re-renders the active list to thread the resolved `historyPresent`
// flag. If the user re-opens the Smart tasks tab — firing a fresh
// `refreshDeadlinesList()` — before a prior history request settles, the older
// callback would otherwise fire late and re-render the active surface with its
// own (now stale) cards / empty-state, clobbering the newer loading/error/ready
// paint. Each invocation captures the counter value at entry and the history
// callback only re-renders the active list while its generation is still the
// latest. The history SURFACE render is unaffected — only the active-list
// re-render is gated.
let refreshGeneration = 0;

const renderHistorySurface = (
  surface: HTMLElement,
  payload: SettingsUiDeferredObjectivePlanHistoryPayload | null,
): void => {
  const entries = resolveDeadlinesHistoryEntries(payload);
  // Render `empty` (with copy) rather than `hidden` so a brand-new user who
  // has never finished a smart task still sees the Past tasks heading and an
  // explanatory line — the section silently vanishing was the bug. `hidden`
  // remains a valid state for callers that genuinely want to suppress the
  // section (e.g. a transient render before any data has arrived).
  if (entries.length === 0) {
    renderDeadlinesHistoryList(surface, { status: 'empty' });
    return;
  }
  ensureDeviceFilterInitialized();
  const handleSelectDevice = (deviceId: string | null): void => {
    activeDeviceFilter = deviceId;
    writePersistedDeviceFilter(deviceId);
    // Re-render the same payload from cache so the chip row reflects the new
    // selection immediately — no network round-trip needed since the filter
    // is a pure view-side narrowing.
    renderHistorySurface(surface, payload);
  };
  const state: DeadlinesHistoryListState = {
    status: 'ready',
    entries,
    timeZone: resolveBrowserTimeZone(),
    // No cost unit/divisor threaded in — each entry's recorded `costDisplay`
    // drives its own row + the week roll-up (see comment above).
    selectedDeviceId: activeDeviceFilter,
    onSelectDevice: handleSelectDevice,
  };
  renderDeadlinesHistoryList(surface, state);
};

export const refreshDeadlinesList = async (): Promise<void> => {
  const surface = getSurface();
  if (!surface) return;
  // Claim a generation for this invocation. A later refresh bumps the counter,
  // which stales any in-flight history callback from this invocation so it
  // can't re-render the active surface over the newer paint.
  refreshGeneration += 1;
  const generation = refreshGeneration;
  const historySurface = getHistorySurface();
  renderDeadlinesList(surface, { status: 'loading' });
  if (historySurface) renderDeadlinesHistoryList(historySurface, { status: 'loading' });

  // Coordinate the active list's empty state with the (independently fetched)
  // history archive. The active list's zero-card branch must distinguish a
  // true first run from a between-runs lull, which depends on whether the Past
  // tasks archive has any finished runs. The two fetches resolve on their own
  // schedules and the history fetch must not gate the active list's first
  // paint, so we render the active `ready` state as soon as cards are known —
  // with `historyPresent` left undefined (the view falls back to first-run
  // copy) — and re-render once the history fetch lands and we know the flag.
  // The combiner reads whichever of the two signals have arrived; either the
  // bootstrap `.then` (cards) or the history `.then` (presence) can trigger it.
  let latestCards: DeadlinesListCard[] | null = null;
  let historyPresent: boolean | undefined;
  const renderActiveReady = (): void => {
    if (latestCards === null) return;
    const state: DeadlinesListState = {
      status: 'ready',
      cards: latestCards,
      historyPresent,
    };
    renderDeadlinesList(surface, state);
  };

  // Fire history fetch in parallel but don't await it before rendering the
  // active list — history is optional and a slow/hanging endpoint must not
  // gate first paint of the primary Smart tasks list. The same payload feeds
  // both the history surface render and the active list's empty-state branch,
  // so a single fetch resolves both (no second round-trip).
  const historyTarget = historySurface;
  void fetchPlanHistoryOrNull().then((payload) => {
    if (historyTarget) renderHistorySurface(historyTarget, payload);
    // `historyPresent` is the empty-state discriminator: true when at least
    // one finished run exists in the archive. Resolved through the same
    // entry-extraction helper the history surface uses so the active list and
    // the archive agree on what "has history" means.
    historyPresent = resolveDeadlinesHistoryEntries(payload).length > 0;
    // Gate the active-list re-render: only the latest invocation may repaint
    // the active surface. A stale (older-generation) callback that resolves
    // after a newer refresh has started must not overwrite the newer paint.
    // The history surface render above is unaffected — it always reflects this
    // fetch's own payload.
    if (generation === refreshGeneration) renderActiveReady();
  });

  try {
    const [bootstrap, devicesPayload] = await Promise.all([
      callApi<SettingsUiBootstrap>('GET', SETTINGS_UI_BOOTSTRAP_PATH),
      callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH),
    ]);
    const objectiveSettings = normalizeDeferredObjectiveSettings(
      bootstrap.settings.deferred_objectives,
    );
    latestCards = resolveDeadlinesListCards({
      activePlans: bootstrap.deferredObjectiveActivePlans,
      objectiveSettings,
      devices: devicesPayload.devices,
    });
    renderActiveReady();
  } catch (error) {
    await logSettingsError('Failed to load deadlines list', error, 'refreshDeadlinesList');
    renderDeadlinesList(surface, {
      status: 'error',
      message: SMART_TASK_LIST_LOAD_ERROR_COPY,
    });
  }
};

export const testExports = {
  resolveDeadlinesListCards,
  resolveDeadlinesHistoryEntries,
  // Past-tasks device-filter persistence — surfaced for tests so they can
  // exercise the round-trip without coupling to the localStorage key name.
  HISTORY_DEVICE_FILTER_STORAGE_KEY,
  // In-memory cache reset; lets each test land on a deterministic "no filter
  // active" baseline before the renderer reads the persisted value.
  resetDeviceFilterCacheForTests: (): void => {
    activeDeviceFilter = null;
    activeDeviceFilterInitialized = false;
  },
  renderHistorySurface,
};
