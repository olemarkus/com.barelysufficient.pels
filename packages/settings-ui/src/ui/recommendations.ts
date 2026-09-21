import {
  SETTINGS_UI_RECOMMENDATION_CARS_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi, getSetting, getSettingFresh, sleep } from './homey.ts';
import { logSettingsError } from './logging.ts';
import {
  groupSetupRecommendations,
  normalizeRecommendationDismissals,
  parseRecommendationCarsRead,
  resolveSetupRecommendations,
  type RecommendationDismissals,
  type SetupRecommendation,
} from './recommendationsModel.ts';
import type { SettingsUiRecommendationCar } from '../../../contracts/src/settingsUiApi.ts';
import { state } from './state.ts';
import { notifySetupPathChange, onSetupPathChange, readSetupPath } from './setupPathFacts.ts';
import {
  loadAfterSetupFacts,
  readAfterSetupFacts,
  type AfterSetupFactsRead,
} from './afterSetupFacts.ts';
import { resolveAfterSetupRecommendations } from './afterSetupRecommendations.ts';
import { loadHubMarket } from './hubMarket.ts';
import { formatSetupProgress } from './setupPathModel.ts';
import { loadEvCarAssociations } from './deviceDetail/carAssociation.ts';
import {
  createSerializedAsyncRunner,
  readRecordSetting,
  writeFreshSetting,
} from './deviceDetail/settingsWrite.ts';
import {
  renderSetupRecommendationsBanner,
  renderSetupRecommendationsView,
} from './views/SetupRecommendationsView.tsx';
import {
  checkFlowConflictNow,
  hasEvSocFlowReporter,
  readEvSocFlowReporters,
  refreshFlowConflictFacts,
  refreshFlowConflictFactsExplicit,
} from './flowConflictRefresh.ts';
import { showToast, showToastError } from './toast.ts';
import { subscribeToHomeScope } from './homeScope.ts';

export type RecommendationNavigation = {
  openPanel: (panelId: string) => void;
  openDevice: (deviceId: string) => void;
};

// Browser-owned acknowledgement state. The runtime never reads this key.
export const SETUP_RECOMMENDATION_DISMISSALS = 'setup_recommendation_dismissals';

type DismissalReadState =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'resolved'; dismissals: RecommendationDismissals }
  | { state: 'stale'; dismissals: RecommendationDismissals };

type CarInventoryState =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'resolved'; cars: SettingsUiRecommendationCar[] }
  | { state: 'stale'; cars: SettingsUiRecommendationCar[] };

type NavigationState =
  | { state: 'uninitialized' }
  | { state: 'resolved'; navigation: RecommendationNavigation };

type RecommendationReadiness = 'loading' | 'partial' | 'resolved';

type LoadedDismissalReadState = Extract<DismissalReadState, { state: 'resolved' | 'stale' }>;

let dismissalRead: DismissalReadState = { state: 'loading' };
let carInventory: CarInventoryState = { state: 'loading' };
let navigationRead: NavigationState = { state: 'uninitialized' };
let loadGeneration = 0;
let dismissalRevision = 0;
let carInventoryGeneration = 0;
let carInventoryRefresh: Promise<void> | undefined;
let busyRecommendationId: string | null = null;
const runSerializedDismissalWrite = createSerializedAsyncRunner();
const RECOMMENDATION_READ_RETRY_DELAYS_MS = [250, 750] as const;

const hasLoadedDismissals = (read: DismissalReadState): read is LoadedDismissalReadState => (
  read.state === 'resolved' || read.state === 'stale'
);

const resolveRecommendationReadiness = (afterSetupRead: AfterSetupFactsRead): RecommendationReadiness => {
  if (!state.devicesLoaded) return 'loading';
  const needsFlowReporterCheck = Object.values(state.evCarAssociations)
    .some((association) => association.carIds.length > 0);
  const flowReporterRead = readEvSocFlowReporters();
  return state.evCarAssociationsLoaded
    && carInventory.state === 'resolved'
    && (!needsFlowReporterCheck || flowReporterRead.state === 'resolved')
    && afterSetupRead.state === 'resolved'
    ? 'resolved'
    : 'partial';
};

const getSurfaces = (): { banner: HTMLElement | null; page: HTMLElement | null } => ({
  banner: document.getElementById('setup-recommendations-banner-root'),
  page: document.getElementById('setup-recommendations-root'),
});

const resolveCurrentRecommendations = (afterSetupRead: AfterSetupFactsRead): SetupRecommendation[] => {
  if (!state.devicesLoaded) return [];
  const cars = state.evCarAssociationsLoaded
    && (carInventory.state === 'resolved' || carInventory.state === 'stale')
    ? carInventory.cars
    : [];
  const flowReporterRead = readEvSocFlowReporters();
  const evSocReporters = state.evCarAssociationsLoaded
    && (flowReporterRead.state === 'resolved' || flowReporterRead.state === 'stale')
    ? flowReporterRead.reporters
    : [];
  // Device fixes first, by name; then what PELS can do next, in the order the
  // setup path's lede names them. The second group is not sorted into the
  // first: a wiring fix for one device outranks an optional feature.
  return [
    ...resolveSetupRecommendations(
      state.latestDevices,
      cars,
      state.evCarAssociations,
      state.nativeWiringMap,
      evSocReporters,
    ),
    ...(afterSetupRead.state === 'resolved'
      ? resolveAfterSetupRecommendations(afterSetupRead.facts)
      : []),
  ];
};

const isDismissalRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const loadDismissalSetting = async (): Promise<unknown> => {
  let [read] = await Promise.allSettled([getSetting(SETUP_RECOMMENDATION_DISMISSALS)]);
  for (const delayMs of RECOMMENDATION_READ_RETRY_DELAYS_MS) {
    if (read.status === 'fulfilled' && isDismissalRecord(read.value)) break;
    await sleep(delayMs);
    [read] = await Promise.allSettled([getSettingFresh(SETUP_RECOMMENDATION_DISMISSALS)]);
  }
  if (read.status === 'rejected') throw read.reason;
  return read.value;
};

const loadRecommendationCars = async (): Promise<unknown> => {
  let value = await callApi<unknown>('GET', SETTINGS_UI_RECOMMENDATION_CARS_PATH);
  for (const delayMs of RECOMMENDATION_READ_RETRY_DELAYS_MS) {
    if (parseRecommendationCarsRead(value).state !== 'unavailable') break;
    await sleep(delayMs);
    value = await callApi<unknown>('GET', SETTINGS_UI_RECOMMENDATION_CARS_PATH);
  }
  return value;
};

const applyDismissalRead = async (result: PromiseSettledResult<unknown>): Promise<void> => {
  if (result.status === 'rejected') {
    dismissalRead = dismissalRead.state === 'resolved' || dismissalRead.state === 'stale'
      ? { state: 'stale', dismissals: dismissalRead.dismissals }
      : { state: 'unavailable' };
    await logSettingsError(
      'Failed to load recommendation acknowledgements',
      result.reason,
      'setup recommendations',
    );
    return;
  }
  const rawDismissals = result.value;
  if (isDismissalRecord(rawDismissals)) {
    dismissalRead = { state: 'resolved', dismissals: normalizeRecommendationDismissals(rawDismissals) };
    return;
  }
  if ((dismissalRead.state === 'loading' || dismissalRead.state === 'unavailable')
    && (rawDismissals === null || rawDismissals === undefined)) {
    // An absent key is the normal first-run state. Once a last-good map exists,
    // the same SDK result is treated as unavailable and remains a no-op.
    dismissalRead = { state: 'resolved', dismissals: {} };
    return;
  }
  dismissalRead = dismissalRead.state === 'resolved' || dismissalRead.state === 'stale'
    ? { state: 'stale', dismissals: dismissalRead.dismissals }
    : { state: 'unavailable' };
  await logSettingsError(
    'Ignoring unavailable recommendation acknowledgements',
    new TypeError('Invalid recommendation acknowledgement setting.'),
    'setup recommendations',
  );
};

const applyCarInventoryRead = async (result: PromiseSettledResult<unknown>): Promise<void> => {
  if (result.status === 'rejected') {
    carInventory = carInventory.state === 'resolved' || carInventory.state === 'stale'
      ? { state: 'stale', cars: carInventory.cars }
      : { state: 'unavailable' };
    await logSettingsError('Failed to load cars for recommendations', result.reason, 'setup recommendations');
    return;
  }
  const parsed = parseRecommendationCarsRead(result.value);
  if (parsed.state === 'resolved') {
    carInventory = { state: 'resolved', cars: parsed.cars };
    return;
  }
  carInventory = carInventory.state === 'resolved' || carInventory.state === 'stale'
    ? { state: 'stale', cars: carInventory.cars }
    : { state: 'unavailable' };
};

const runRecommendationAction = (recommendation: SetupRecommendation): void => {
  const { target } = recommendation;
  if (target.kind === 'flow-conflict-check') {
    if (busyRecommendationId !== null) return;
    busyRecommendationId = recommendation.id;
    refreshRecommendationSurfaces();
    void checkFlowConflictNow(target.deviceId)
      .then((hasConflict) => showToast(
        hasConflict ? 'PELS still finds Flow control for this device.' : 'No conflicting Flow control found.',
        hasConflict ? 'warn' : 'ok',
      ))
      .catch((error) => showToastError(error, 'Could not check Homey Flows. Try again.'))
      .finally(() => {
        busyRecommendationId = null;
        refreshRecommendationSurfaces();
      });
    return;
  }
  if (target.kind === 'ev-soc-flow-conflict-check') {
    if (busyRecommendationId !== null) return;
    busyRecommendationId = recommendation.id;
    refreshRecommendationSurfaces();
    void refreshFlowConflictFactsExplicit()
      .then(() => {
        const hasSelectedCar = (state.evCarAssociations[target.deviceId]?.carIds.length ?? 0) > 0;
        const hasConflict = hasSelectedCar && hasEvSocFlowReporter(target.deviceId);
        return showToast(
          hasConflict ? 'PELS still finds battery reporting for this charger.' : 'No unused battery reporting found.',
          hasConflict ? 'warn' : 'ok',
        );
      })
      .catch((error) => showToastError(error, 'Could not check Homey Flows. Try again.'))
      .finally(() => {
        busyRecommendationId = null;
        refreshRecommendationSurfaces();
      });
    return;
  }
  if (navigationRead.state !== 'resolved') return;
  if (target.kind === 'panel') {
    navigationRead.navigation.openPanel(target.panelId);
    return;
  }
  navigationRead.navigation.openPanel('devices');
  if (target.kind === 'device') navigationRead.navigation.openDevice(target.deviceId);
};

const writeDismissal = async (recommendation: SetupRecommendation, dismissed: boolean): Promise<void> => {
  if (!hasLoadedDismissals(dismissalRead)) return;
  await writeFreshSetting<RecommendationDismissals>({
    key: SETUP_RECOMMENDATION_DISMISSALS,
    context: 'setup recommendations',
    logMessage: 'Failed to update recommendation acknowledgement',
    toastMessage: 'Failed to update the recommendation.',
    fallbackValue: dismissalRead.dismissals,
    readFresh: (value, fallback) => normalizeRecommendationDismissals(readRecordSetting(value, fallback)),
    mutate: (current) => {
      const next = { ...current };
      if (dismissed) next[recommendation.id] = recommendation.version;
      else delete next[recommendation.id];
      return next;
    },
    commit: (next) => {
      dismissalRevision += 1;
      dismissalRead = { state: 'resolved', dismissals: next };
      refreshRecommendationSurfaces();
    },
    rollback: refreshRecommendationSurfaces,
  });
};

export const refreshRecommendationSurfaces = (): void => {
  const { banner, page } = getSurfaces();
  const afterSetupRead = readAfterSetupFacts();
  const hasDismissals = hasLoadedDismissals(dismissalRead);
  const coreLoaded = hasDismissals && state.devicesLoaded;
  const readiness = resolveRecommendationReadiness(afterSetupRead);
  const dismissals = hasLoadedDismissals(dismissalRead) ? dismissalRead.dismissals : {};
  const groups = groupSetupRecommendations(resolveCurrentRecommendations(afterSetupRead), dismissals);
  if (banner) {
    renderSetupRecommendationsBanner(banner, {
      active: coreLoaded ? groups.active : [],
      onOpen: () => {
        if (navigationRead.state === 'resolved') navigationRead.navigation.openPanel('recommendations');
      },
    });
  }
  const setupRead = readSetupPath();
  const chip = document.getElementById('settings-nav-chip-recommendations');
  if (chip) {
    // Open setup outranks the suggestion count: it is what the row is for until
    // it is done, and one chip cannot carry both numbers.
    const hasSuggestions = coreLoaded && groups.active.length > 0;
    chip.hidden = setupRead.state !== 'open' && !hasSuggestions;
    if (setupRead.state === 'open') chip.textContent = formatSetupProgress(setupRead.path);
    else if (hasSuggestions) chip.textContent = String(groups.active.length);
  }
  if (page) {
    renderSetupRecommendationsView(page, {
      ...groups,
      setupPath: setupRead,
      readiness,
      dismissalStatus: hasLoadedDismissals(dismissalRead) ? 'available' : dismissalRead.state,
      retryAvailable: dismissalRead.state === 'unavailable'
        || (Object.values(state.evCarAssociations).some((association) => association.carIds.length > 0)
          && ['stale', 'unavailable'].includes(readEvSocFlowReporters().state)),
      busyRecommendationId,
      onAction: runRecommendationAction,
      onDismiss: (recommendation) => {
        void runSerializedDismissalWrite(() => writeDismissal(recommendation, true));
      },
      onRestore: (recommendation) => {
        void runSerializedDismissalWrite(() => writeDismissal(recommendation, false));
      },
      onRetry: retryRecommendationData,
    });
  }
};

export const refreshAfterSetupRecommendations = async (): Promise<void> => {
  await loadAfterSetupFacts();
  refreshRecommendationSurfaces();
};

export const loadRecommendationDismissals = async (): Promise<void> => {
  loadGeneration += 1;
  const generation = loadGeneration;
  const dismissalRevisionAtStart = dismissalRevision;
  const [dismissalResult] = await Promise.allSettled([loadDismissalSetting()]);
  if (generation !== loadGeneration) return;
  if (dismissalRevisionAtStart === dismissalRevision) {
    await applyDismissalRead(dismissalResult);
  }
  if (generation !== loadGeneration) return;
  refreshRecommendationSurfaces();
};

// Device events during a read invalidate that result and share one follow-up
// read. Car discovery never reloads or invalidates acknowledgement state.
const readLatestCarInventory = async (): Promise<void> => {
  let generation: number;
  do {
    generation = carInventoryGeneration;
    const [result] = await Promise.allSettled([loadRecommendationCars()]);
    if (generation !== carInventoryGeneration) continue;
    await applyCarInventoryRead(result);
  } while (generation !== carInventoryGeneration);
  refreshRecommendationSurfaces();
};

const refreshCarInventory = (): Promise<void> => {
  carInventoryGeneration += 1;
  refreshRecommendationSurfaces();
  carInventoryRefresh ??= readLatestCarInventory().finally(() => { carInventoryRefresh = undefined; });
  return carInventoryRefresh;
};

const loadRecommendationFlowFacts = async (
  refresh: typeof refreshFlowConflictFacts = refreshFlowConflictFacts,
): Promise<void> => {
  try {
    await refresh();
  } catch (error) {
    await logSettingsError('Failed to check Homey Flows for recommendations', error, 'setup recommendations');
  }
  refreshRecommendationSurfaces();
};

export const loadRecommendationData = async (): Promise<void> => {
  await Promise.all([
    loadRecommendationDismissals(),
    refreshCarInventory(),
    loadAfterSetupFacts().then(refreshRecommendationSurfaces),
    loadRecommendationFlowFacts(),
    // Publishes to the setup path, which redraws these surfaces on a change.
    loadHubMarket(),
  ]);
};

const retryRecommendationData = (): void => {
  const retryDismissals = dismissalRead.state === 'unavailable';
  const retryFlowFacts = ['stale', 'unavailable'].includes(readEvSocFlowReporters().state);
  if (!retryDismissals && !retryFlowFacts) return;
  if (retryDismissals) dismissalRead = { state: 'loading' };
  refreshRecommendationSurfaces();
  void Promise.all([
    retryDismissals ? loadRecommendationDismissals() : Promise.resolve(),
    retryFlowFacts ? loadRecommendationFlowFacts(refreshFlowConflictFactsExplicit) : Promise.resolve(),
  ]);
};

export const clearRecommendationDismissals = (): void => {
  loadGeneration += 1;
  dismissalRevision += 1;
  dismissalRead = { state: 'resolved', dismissals: {} };
  refreshRecommendationSurfaces();
};

const readTabId = (event: Event): string => {
  if (!(event instanceof CustomEvent) || typeof event.detail !== 'object' || event.detail === null) return '';
  const detail = event.detail as Record<string, unknown>;
  return typeof detail.tabId === 'string' ? detail.tabId : '';
};

export const initRecommendationSurfaces = (nextNavigation: RecommendationNavigation): void => {
  navigationRead = { state: 'resolved', navigation: nextNavigation };
  // Recommendation applicability depends on the identities of Main-home
  // devices, not only on the setup path's aggregate counts.
  subscribeToHomeScope(refreshRecommendationSurfaces);
  document.addEventListener('devices-updated', () => { void refreshCarInventory(); });
  document.addEventListener('ev-car-associations-updated', refreshRecommendationSurfaces);
  onSetupPathChange(refreshRecommendationSurfaces);
  // The device list is one of the path's facts, and it lands without any of the
  // path's publishers being involved. Gated inside: a tick that leaves the path
  // unchanged redraws nothing.
  document.addEventListener('devices-updated', notifySetupPathChange);
  // A Smart task added or cleared elsewhere changes whether one is suggested.
  document.addEventListener('deferred-objectives-updated', refreshRecommendationSurfaces);
  document.addEventListener('pels:tab-shown', (event) => {
    const panelId = readTabId(event);
    if (panelId === 'recommendations') {
      const associationLoad = state.evCarAssociationsLoaded
        ? Promise.resolve()
        : loadEvCarAssociations();
      const dismissalLoad = dismissalRead.state === 'resolved'
        ? Promise.resolve()
        : loadRecommendationDismissals();
      // Flow inventory can change while this WebView stays open. Refresh on
      // every visit so a newly added reporting action can create a suggestion.
      const flowFactsLoad = loadRecommendationFlowFacts();
      void Promise.all([
        refreshCarInventory(),
        dismissalLoad,
        associationLoad,
        flowFactsLoad,
      ]).then(refreshRecommendationSurfaces);
    } else if (panelId === 'overview' || panelId === 'settings') {
      refreshRecommendationSurfaces();
    }
  });
  refreshRecommendationSurfaces();
};
