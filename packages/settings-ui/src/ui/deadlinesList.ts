import { state } from './state.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import {
  type SettingsUiDeferredObjectivePlanHistoryPayload,
} from '../../../contracts/src/deferredObjectivePlanHistory.ts';
import { type SettingsUiBootstrap } from '../../../contracts/src/settingsUi/bootstrap.ts';
import { type SettingsUiDevicesPayload } from '../../../contracts/src/settingsUi/devices.ts';
import { MODE_PREPARATION_QUERY_PARAM } from '../../../shared-domain/src/settings/schedules.ts';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_DEVICES_PATH,
} from '../../../contracts/src/settingsUi/paths.ts';
import { readDeferredObjectiveHistory } from './deferredObjectiveHistoryRead.ts';
import { normalizeDeferredObjectiveRoster } from './deferredObjectiveRoster.ts';
import type { DeferredObjectiveRoster } from '../../../contracts/src/deferredObjectiveSettings.ts';
import type {
  ResolvedDeferredObjectiveActivePlansV2,
  ResolvedDeferredObjectiveActivePlanV1,
} from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../../contracts/src/deferredObjectivePlanHistory.ts';
import type { ObservedDeviceState } from '../../../contracts/src/types.ts';
import {
  resolveSmartTaskRowFacts,
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
  resolveSmartTaskCreateOverrideNote,
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
  resolveChipConfidence,
  resolveSmartTaskLearning,
} from '../../../shared-domain/src/smartTaskCopy/estimateConfidence.ts';
import { SMART_TASK_LIST_LOAD_ERROR_COPY } from '../../../shared-domain/src/smartTaskCopy/listCopy.ts';
import type { SmartTaskListStatusId } from '../../../shared-domain/src/smartTaskCopy/listStatus.ts';
import {
  formatSmartTaskExtraPermissionsValue,
} from '../../../shared-domain/src/smartTaskCopy/permissionsCopy.ts';
import {
  DEVICE_IDLE_LIST_LINE,
  resolveSmartTaskBudgetRole,
  resolveSmartTaskLiveCause,
  type SmartTaskCarChargeLimit,
} from '../../../shared-domain/src/smartTaskCopy/shortfallCauses.ts';
import { formatSmartTaskCurrentValueLine } from '../../../shared-domain/src/smartTaskCopy/valueFormat.ts';
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
import { renderModePreparationPanel } from './views/ModePreparationPanel.tsx';
import { mountDeyeDischargeHold } from './deyeDischargeHold.tsx';

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
  if (statusId === 'device_idle') return DEVICE_IDLE_LIST_LINE;
  if (statusId !== 'at_risk' && statusId !== 'cannot_meet') return null;
  const budgetRole = plan.latest === null ? 'none' : resolveSmartTaskBudgetRole(plan.latest);
  return resolveSmartTaskLiveCause(plan.diagnosticReasonCode, carChargeLimit, budgetRole)?.listLine ?? null;
};

const buildCard = (
  deviceId: string,
  plan: ResolvedDeferredObjectiveActivePlanV1,
  objective: DeferredObjectiveRoster['objectivesByDeviceId'][string] | undefined,
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
    firstActionAtMs,
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
  activePlans: ResolvedDeferredObjectiveActivePlansV2 | null,
  objectiveSettings: DeferredObjectiveRoster,
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

const getModePreparationSurface = (): HTMLElement | null => (
  document.getElementById('mode-preparation-root')
);
const modePreparationPath = `${SETTINGS_UI_DEVICES_PATH}?${MODE_PREPARATION_QUERY_PARAM}=next`;
let modePreparationReadPending = false;
let hasModePreparation = false;

const refreshModePreparation = async (): Promise<void> => {
  const surface = getModePreparationSurface();
  if (!surface || modePreparationReadPending) return;
  modePreparationReadPending = true;
  try {
    const { schedules } = await callApi<Pick<SettingsUiDevicesPayload, 'schedules'>>('GET', modePreparationPath);
    if (schedules?.ok === true) {
      const plan = schedules.data.preparationPlan ?? { state: 'inactive' as const };
      hasModePreparation = plan.state !== 'inactive';
      const panel = plan.state === 'ready' ? { ...plan, timeZone: schedules.data.timeZone } : plan;
      renderModePreparationPanel(surface, panel);
      return;
    }
  } catch {
    // The plan read is independent of the active and past task lists.
  } finally {
    modePreparationReadPending = false;
  }
  if (hasModePreparation) {
    renderModePreparationPanel(surface, {
      state: 'unavailable', reason: 'The mode preparation plan could not be refreshed.',
    });
  }
};

export const refreshModePreparationIfVisible = (): void => {
  const root = getModePreparationSurface();
  const panel = document.getElementById('deadlines-panel');
  if (hasModePreparation && root && !root.hidden && panel && !panel.classList.contains('hidden')) {
    void refreshModePreparation();
  }
};

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

// Each page ignores reads superseded by a newer refresh of that page.
let refreshGeneration = 0;
let historyRefreshGeneration = 0;

const renderHistorySurface = (
  surface: HTMLElement,
  entries: ResolvedDeferredObjectivePlanHistoryEntry[],
): void => {
  if (entries.length === 0) {
    renderDeadlinesHistoryList(surface, { status: 'empty' });
    return;
  }
  ensureDeviceFilterInitialized();
  const handleSelectDevice = (deviceId: string | null): void => {
    activeDeviceFilter = deviceId;
    writePersistedDeviceFilter(deviceId);
    // Re-render the same entries so the chip row reflects the new
    // selection immediately — no network round-trip needed since the filter
    // is a pure view-side narrowing.
    renderHistorySurface(surface, entries);
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

export const refreshDeadlinesHistory = async (): Promise<void> => {
  const surface = getHistorySurface();
  if (!surface) return;
  const generation = ++historyRefreshGeneration;
  renderDeadlinesHistoryList(surface, { status: 'loading' });
  const payload = await readDeferredObjectiveHistory('deadlines-history').catch(() => null);
  if (generation !== historyRefreshGeneration) return;
  if (payload === null) {
    renderDeadlinesHistoryList(surface, {
      status: 'error',
      onRetry: () => { void refreshDeadlinesHistory(); },
    });
    return;
  }
  renderHistorySurface(surface, resolveDeadlinesHistoryEntries(payload));
};

// Task schedules that are switched on but cannot run, from the last schedules read that succeeded.
let schedulesNotRunning = 0;

export const refreshDeadlinesList = async (): Promise<void> => {
  const surface = getSurface();
  if (!surface) return;
  mountDeyeDischargeHold();
  void refreshModePreparation();
  const generation = ++refreshGeneration;
  renderDeadlinesList(surface, { status: 'loading' }, listActions);

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
    if (generation !== refreshGeneration || latestCards === null) return;
    const state: DeadlinesListState = {
      status: 'ready',
      cards: latestCards,
      historyPresent,
      schedulesNotRunning,
      // Honest Main-only notice gate (multi-home locked decision 4). Read at
      // render time from the shell's roster — fresh here because the roster
      // refreshes on `homes_config` realtime pushes and on every scope-aware
      // panel activation, and this panel refreshes on its own activation.
      meterAreasInUse: areMeterAreasInUse(),
    };
    renderDeadlinesList(surface, state, listActions);
  };

  // History only informs the landing page's empty-state copy and never gates
  // the active list. The archive renders on its own page.
  void readDeferredObjectiveHistory('deadlines').then((payload) => {
    historyPresent = resolveDeadlinesHistoryEntries(payload).length > 0;
    if (latestCards?.length === 0) renderActiveReady();
  }, () => {});

  try {
    const [bootstrap, devicesPayload] = await Promise.all([
      callApi<SettingsUiBootstrap>('GET', SETTINGS_UI_BOOTSTRAP_PATH),
      callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH),
    ]);
    if (generation !== refreshGeneration) return;
    const objectiveSettings = normalizeDeferredObjectiveRoster(bootstrap.deferredObjectives);
    // An unavailable schedules read keeps the last count: it is not a home with no such schedule.
    if (devicesPayload.schedules?.ok === true) {
      schedulesNotRunning = devicesPayload.schedules.data.entries
        .filter((entry) => entry.schedule.action.type === 'task' && entry.state === 'invalid').length;
    }
    latestCards = resolveDeadlinesListCards(
      bootstrap.deferredObjectiveActivePlans,
      objectiveSettings,
      devicesPayload.devices,
      Date.now(),
    );
    renderActiveReady();
  } catch (error) {
    await logSettingsError('Failed to load deadlines list', error, 'refreshDeadlinesList');
    if (generation !== refreshGeneration) return;
    renderDeadlinesList(surface, {
      status: 'error',
      message: SMART_TASK_LIST_LOAD_ERROR_COPY,
    }, listActions);
  }
};

// The Main-only notice's only external input is the shell's roster; refresh a
// VISIBLE Smart tasks panel when it changes (an
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
/** On the New smart task flow while Simulation mode is on: the plan is shown, never carried out. */
export const SMART_TASK_SIMULATION_NOTE = 'Simulation mode is on. PELS plans this Smart task and shows the plan, '
  + 'but does not run the device.';

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

// The flow shares this tab with the active task list and mode preparation. Closing
// it brings those surfaces back refreshed.
const setListVisible = (visible: boolean): void => {
  const list = document.getElementById('deadlines-list-root');
  const surface = document.getElementById('smart-task-create-root');
  const deye = document.getElementById('deye-discharge-hold-root');
  if (list) list.hidden = !visible;
  if (deye) deye.hidden = !visible;
  const modePreparation = getModePreparationSurface();
  if (modePreparation) modePreparation.hidden = !visible;
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
    solarNote: (step.kind === 'compose' || step.kind === 'preview')
      && state.priceOptimizationSettings[step.device.deviceId]?.surplusWilling === true
      ? 'While active, the Smart task runs this device in the periods it plans, also on grid electricity. '
        + 'Between them the device still runs on your solar surplus.'
      : null,
    simulationNote: (step.kind === 'compose' || step.kind === 'preview') && state.dryRun
      ? SMART_TASK_SIMULATION_NOTE : null,
    overrideNote: step.kind === 'compose' || step.kind === 'preview'
      ? resolveSmartTaskCreateOverrideNote(step.device.deviceId) : null,
    actions: smartTaskCreateActions,
  });
};

registerSmartTaskCreateRenderer(paintSmartTaskCreate);
