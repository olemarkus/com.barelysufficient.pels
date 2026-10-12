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
import { normalizeDeferredObjectiveSettings } from '../../../shared-domain/src/settings/deferredObjectiveSettings.ts';
import type { DeferredObjectiveSettingsV1 } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type {
  ResolvedDeferredObjectiveActivePlansV1,
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../contracts/src/deferredObjectivePlanHistory.ts';
import type { ObservedDeviceState } from '../../../contracts/src/types.ts';
import {
  resolveSmartTaskRowFacts,
  smartTaskScheduleNoLongerGoverns,
} from '../../../shared-domain/src/smartTaskRowFacts.ts';
import { flattenPlanHistoryEntries } from '../../../shared-domain/src/deferredPlanHistory.ts';
import { buildDeadlineHref } from './deadlineUrls.ts';
import { renderSmartTaskCreate, type SmartTaskCreateActions } from './views/SmartTaskCreate.tsx';
import {
  backFromSmartTaskCreate,
  openSmartTaskCreate,
  openSmartTaskCreateDeviceSettings,
  registerSmartTaskCreateRenderer,
  requestSmartTaskCreatePreview,
  resolveSmartTaskCreateAfterTaskLine,
  retrySmartTaskCreateLoad,
  selectSmartTaskCreateDevice,
  setSmartTaskCreateGoal,
  setSmartTaskCreatePermission,
  setSmartTaskCreateReadyBy,
  submitSmartTaskCreate,
  type SmartTaskCreateSnapshot,
} from './smartTaskCreate.ts';
import { resolveBrowserTimeZone } from './deadlinePlanHistoryFetch.ts';
import { areMeterAreasInUse, subscribeToHomeScope } from './homeScope.ts';
import {
  formatSmartTaskExtraPermissionsValue,
  formatSmartTaskCurrentValueLine,
  resolveChipConfidence,
  resolveSmartTaskBudgetRole,
  resolveSmartTaskLearning,
  resolveSmartTaskLiveCause,
  SMART_TASK_LIST_LOAD_ERROR_COPY,
  type SmartTaskCarChargeLimit,
  type SmartTaskListStatusId,
} from '../../../shared-domain/src/deadlineLabels.ts';
import {
  renderDeadlinesList,
  type DeadlinesListActions,
  type DeadlinesListCard,
  type DeadlinesListState,
} from './views/DeadlinesList.tsx';
import {
  renderDeadlinesHistoryList,
  type DeadlinesHistoryListState,
} from './views/DeadlinesHistoryList.tsx';

// The card's line beside the target: the same live cause the widget and the
// detail hero name (stopped taking power, the car's own limit
// or schedule), in its short form. Only on a card whose status that cause
// explains, at risk or cannot finish: beside "Building plan…", a pause, an
// unavailable or a satisfied chip, "Car stops at 70%" would contradict the chip.
const resolveListCauseLine = (
  statusId: SmartTaskListStatusId,
  plan: ResolvedDeferredObjectiveActivePlanV1,
  carChargeLimit: SmartTaskCarChargeLimit | null,
): string | null => {
  if (statusId !== 'at_risk' && statusId !== 'cannot_meet') return null;
  const budgetRole = plan.latest === null ? 'none' : resolveSmartTaskBudgetRole(plan.latest);
  return resolveSmartTaskLiveCause(plan.diagnosticReasonCode, carChargeLimit, budgetRole)?.listLine ?? null;
};

const buildCard = (
  deviceId: string,
  plan: ResolvedDeferredObjectiveActivePlanV1,
  objective: DeferredObjectiveSettingsV1['objectivesByDeviceId'][string] | undefined,
  device: ObservedDeviceState | undefined,
  nowMs: number,
): DeadlinesListCard => {
  const { statusId, firstActionAtMs, carChargeLimit, currentValue } = resolveSmartTaskRowFacts(plan, device, nowMs);
  // The hero's chip-confidence chain (`resolveEnergyNeededKWh` in
  // `deadlinePlanResolvers.ts`): the plan's own provenance, one resolver.
  const confidence = resolveChipConfidence(plan.kwhPerUnitProvenance);
  const learning = resolveSmartTaskLearning(plan.kwhPerUnitProvenance);
  return {
    deviceId,
    deviceName: device?.name ?? plan.deviceName ?? deviceId,
    kind: plan.objectiveKind,
    progressDirection: plan.progressDirection,
    targetValue: plan.targetValue,
    // A committed revision can outlive a meter reassignment or an un-manage.
    // Its cached first hour no longer governs the device, so those cards expose
    // only the user-set deadline and never advertise the stale schedule.
    firstActionAtMs: smartTaskScheduleNoLongerGoverns(statusId) ? null : firstActionAtMs,
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
    liveCauseLine: resolveListCauseLine(statusId, plan, carChargeLimit),
  };
};

export const resolveDeadlinesListCards = (
  activePlans: ResolvedDeferredObjectiveActivePlansV1 | null,
  objectiveSettings: DeferredObjectiveSettingsV1,
  devices: readonly ObservedDeviceState[],
  nowMs: number,
): DeadlinesListCard[] => {
  const plans = activePlans?.plansByDeviceId ?? {};
  const devicesById = new Map(devices.map((device) => [device.id, device]));
  const cards: DeadlinesListCard[] = [];
  for (const [deviceId, plan] of Object.entries(plans)) {
    const objective = objectiveSettings.objectivesByDeviceId[deviceId];
    if (!objective?.enabled) continue;
    cards.push(buildCard(deviceId, plan, objective, devicesById.get(deviceId), nowMs));
  }
  cards.sort((a, b) => a.deadlineAtMs - b.deadlineAtMs);
  return cards;
};

export const resolveDeadlinesHistoryEntries = (
  payload: SettingsUiDeferredObjectivePlanHistoryPayload | null,
): ResolvedDeferredObjectivePlanHistoryEntry[] => flattenPlanHistoryEntries(payload);

const listActions: DeadlinesListActions = {
  onNewTask: () => openSmartTaskCreate({ kind: 'smart_tasks' }),
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
// every render). It is read from storage once per page load.
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
  renderDeadlinesList(surface, { status: 'loading' }, listActions);
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
      // Honest Main-only notice gate (multi-home locked decision 4). Read at
      // render time from the shell's roster — fresh here because the roster
      // refreshes on `homes_config` realtime pushes and on every scope-aware
      // panel activation, and this panel refreshes on its own activation.
      meterAreasInUse: areMeterAreasInUse(),
    };
    renderDeadlinesList(surface, state, listActions);
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
    latestCards = resolveDeadlinesListCards(
      bootstrap.deferredObjectiveActivePlans,
      objectiveSettings,
      devicesPayload.devices,
      Date.now(),
    );
    renderActiveReady();
  } catch (error) {
    await logSettingsError('Failed to load deadlines list', error, 'refreshDeadlinesList');
    renderDeadlinesList(surface, {
      status: 'error',
      message: SMART_TASK_LIST_LOAD_ERROR_COPY,
    }, listActions);
  }
};

// The Main-only notice's only external input is the shell's roster +
// activation posture; refresh a VISIBLE Smart tasks panel when they change (an
// area added or removed from the Multiple-meters panel, or a second WebView).
// Scope PICKS also fire this listener, but the picker never renders on this
// panel, so those only arrive while it is hidden. Visibility is checked inline
// (the `budgetRedesign.ts` precedent) — the tab-activation hook covers the
// hidden-panel case on the next open.
subscribeToHomeScope(() => {
  const panel = document.querySelector('#deadlines-panel');
  if (!panel || panel.classList.contains('hidden')) return;
  void refreshDeadlinesList().catch((error: unknown) => {
    void logSettingsError('Failed to refresh deadlines list', error, 'homeScope');
  });
});

// The New smart task flow paints into its own surface on this page. Its
// controller (`smartTaskCreate.ts`) owns the flow; this wires its view and
// refreshes the list it returns to.
const smartTaskCreateActions: SmartTaskCreateActions = {
  onBack: backFromSmartTaskCreate,
  onRetry: retrySmartTaskCreateLoad,
  onSelectDevice: selectSmartTaskCreateDevice,
  onGoalInput: setSmartTaskCreateGoal,
  onReadyByInput: setSmartTaskCreateReadyBy,
  onPermissionToggle: setSmartTaskCreatePermission,
  onPreview: () => { void requestSmartTaskCreatePreview(); },
  onCreate: () => { void submitSmartTaskCreate(); },
  onChangeDeviceSettings: openSmartTaskCreateDeviceSettings,
};

// The flow and the list share this tab: while the flow is open the list and
// its history are hidden, and closing the flow brings them back refreshed.
const setListVisible = (visible: boolean): void => {
  const list = document.getElementById('deadlines-list-root');
  const history = document.getElementById('deadlines-history-root');
  const surface = document.getElementById('smart-task-create-root');
  if (list) list.hidden = !visible;
  if (history) history.hidden = !visible;
  if (surface) surface.hidden = visible;
};

const paintSmartTaskCreate = (snapshot: SmartTaskCreateSnapshot | null): void => {
  const root = document.getElementById('smart-task-create-root');
  if (!root) return;
  setListVisible(snapshot === null);
  if (snapshot === null) {
    renderSmartTaskCreate(root, null);
    void refreshDeadlinesList();
    return;
  }
  const { step } = snapshot;
  renderSmartTaskCreate(root, {
    snapshot,
    afterTaskLine: step.kind === 'preview' ? resolveSmartTaskCreateAfterTaskLine(step.device.deviceId) : null,
    actions: smartTaskCreateActions,
  });
};

registerSmartTaskCreateRenderer(paintSmartTaskCreate);
