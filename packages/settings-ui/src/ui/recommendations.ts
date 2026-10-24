import { chargingRecommendations } from './chargingRecommendations.ts';
import type { ChargingAccessStatus, ChargingCurrentRead } from '../../../contracts/src/chargingControl.ts';
import { CHARGING_ACCESS_PATH, CHARGING_CURRENT_PATH } from '../../../contracts/src/chargingControl.ts';
import {
  SETTINGS_UI_RECOMMENDATION_CARS_PATH,
  SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
  type SettingsUiRecommendationCar,
  type SettingsUiDeferredObjectivePlanHistoryPayload,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi, coldStartReadRetryDelays, getSetting, getSettingFresh, sleep } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import {
  groupSetupRecommendations,
  normalizeRecommendationDismissals,
  resolveSetupRecommendations,
  type RecommendationDismissals,
  type SetupRecommendation,
} from './recommendationsModel.ts';
import { parseCarAssociationCandidatesRead } from './carAssociationCandidates.ts';
import { resolveSolarSetupOffered, state } from './state.ts';
import { recordSmartTaskHistoryDevices } from './smartTaskUsage.ts';
import { resolveDeviceSettingRecommendations } from './deviceSettingRecommendations.ts';
import { notifySetupPathChange, onSetupPathChange, readSetupPath } from './setupPathFacts.ts';
import {
  loadAfterSetupFacts,
  readAfterSetupFacts,
  type AfterSetupFactsRead,
} from './afterSetupFacts.ts';
import { resolveAfterSetupRecommendations } from './afterSetupRecommendations.ts';
import { loadHubMarket } from './hubMarket.ts';
import { loadSetupPrices } from './setupPricesLoad.ts';
import { formatSetupProgress } from './setupPathModel.ts';
import { anyChargerHasSelectedCar, loadEvCarAssociations } from './deviceDetail/carAssociation.ts';
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
  readEvSocFlowReporters,
  refreshFlowConflictFacts,
  refreshFlowConflictFactsExplicit,
  refreshEvSocReportersIfNeeded,
} from './flowConflictRefresh.ts';
import { showToastError } from './toast.ts';
import { resolveRecommendationTask, type RecommendationNavigation } from './recommendationActions.ts';
export type { RecommendationNavigation } from './recommendationActions.ts';
import { subscribeToHomeScope } from './homeScope.ts';

// Browser-owned acknowledgement state. The runtime acts on none of it; it only
// serves the key in the settings bootstrap.
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

let currentChargingRecommendations: SetupRecommendation[] = [];
let chargingReadGeneration = 0;
let chargingReadAt = 0;
async function loadChargingRecommendations(force = false): Promise<void> {
  if (!state.latestDevices.some((device) => device.isEvCharger)) return;
  if (!force && Date.now() - chargingReadAt < 30_000) return;
  chargingReadAt = Date.now();
  const generation = ++chargingReadGeneration;
  try {
    const [devices, access] = await Promise.all([
      callApi<ChargingCurrentRead[]>('GET', CHARGING_CURRENT_PATH),
      callApi<ChargingAccessStatus>('GET', CHARGING_ACCESS_PATH),
    ]);
    if (generation !== chargingReadGeneration) return;
    currentChargingRecommendations = chargingRecommendations(devices, access);
    refreshRecommendationSurfaces();
  } catch {
    // Retain accepted recommendations, but let the next device update retry.
    if (generation === chargingReadGeneration) chargingReadAt = 0;
  }
}

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
let smartTaskUsageRead: 'loading' | 'resolved' | 'unavailable' = 'loading';
let smartTaskUsageGeneration = 0;

const loadSmartTaskUsage = async (): Promise<void> => {
  smartTaskUsageGeneration += 1;
  const generation = smartTaskUsageGeneration;
  try {
    const history = await callApi<SettingsUiDeferredObjectivePlanHistoryPayload>(
      'GET', SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH,
    );
    if (generation !== smartTaskUsageGeneration) return;
    recordSmartTaskHistoryDevices(Object.entries(history.entriesByDeviceId)
      .filter(([, entries]) => entries.length > 0)
      .map(([deviceId]) => deviceId));
    smartTaskUsageRead = 'resolved';
  } catch (error) {
    if (generation !== smartTaskUsageGeneration) return;
    smartTaskUsageRead = 'unavailable';
    await logSettingsError('Failed to read Smart task history for suggestions', error, 'setup recommendations');
  }
  refreshRecommendationSurfaces();
};

const hasLoadedDismissals = (read: DismissalReadState): read is LoadedDismissalReadState => (
  read.state === 'resolved' || read.state === 'stale'
);

const resolveRecommendationReadiness = (afterSetupRead: AfterSetupFactsRead): RecommendationReadiness => {
  if (!state.devicesLoaded) return 'loading';
  const needsFlowReporterCheck = anyChargerHasSelectedCar();
  const flowReporterRead = readEvSocFlowReporters();
  return state.evCarAssociationsLoaded
    && carInventory.state === 'resolved'
    // A car whose match history is unreadable leaves its advice undecided.
    && carInventory.cars.every((car) => car.matchHistory.state === 'resolved')
    && smartTaskUsageRead === 'resolved'
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
  const inventory = carInventory;
  const carsKnown = inventory.state === 'resolved' || inventory.state === 'stale';
  const cars = state.evCarAssociationsLoaded && carsKnown ? inventory.cars : [];
  const flowReporterRead = readEvSocFlowReporters();
  // Whether a battery-level Flow is a leftover or the charger's only working
  // source depends on the car's match history, so neither reading is offered
  // until the car list has loaded, nor from a list that failed to refresh: a
  // past match stays true, but "not matched yet" may have changed since.
  const evSocReporters = state.evCarAssociationsLoaded
    && inventory.state === 'resolved'
    && (flowReporterRead.state === 'resolved' || flowReporterRead.state === 'stale')
    ? flowReporterRead.reporters
    : [];
  // Device fixes first, by name; then what PELS can do next, in the order the
  // setup path's lede names them. The second group is not sorted into the
  // first: a wiring fix for one device outranks an optional feature.
  return [
    ...currentChargingRecommendations.filter(({ target }) => target.kind === 'device'
      && state.latestDevices.some((device) => device.id === target.deviceId)),
    ...resolveSetupRecommendations(
      state.latestDevices,
      cars,
      state.evCarAssociations,
      state.nativeWiringMap,
      evSocReporters,
    ),
    ...resolveDeviceSettingRecommendations(),
    ...(afterSetupRead.state === 'resolved'
      ? resolveAfterSetupRecommendations(afterSetupRead.facts)
      : []),
  ];
};

const loadDismissalSetting = async (): Promise<unknown> => {
  let [read] = await Promise.allSettled([getSetting(SETUP_RECOMMENDATION_DISMISSALS)]);
  // Absence the bootstrap served is the runtime's answer: nothing was ever
  // dismissed. Only a WebView read needs the cold-start grace.
  const retryDelaysMs = coldStartReadRetryDelays(SETUP_RECOMMENDATION_DISMISSALS, RECOMMENDATION_READ_RETRY_DELAYS_MS);
  for (const delayMs of retryDelaysMs) {
    if (read.status === 'fulfilled' && isUnknownRecord(read.value)) break;
    await sleep(delayMs);
    [read] = await Promise.allSettled([getSettingFresh(SETUP_RECOMMENDATION_DISMISSALS)]);
  }
  if (read.status === 'rejected') throw read.reason;
  return read.value;
};

const loadRecommendationCars = async (): Promise<unknown> => {
  let value = await callApi<unknown>('GET', SETTINGS_UI_RECOMMENDATION_CARS_PATH);
  for (const delayMs of RECOMMENDATION_READ_RETRY_DELAYS_MS) {
    if (parseCarAssociationCandidatesRead(value).state !== 'unavailable') break;
    await sleep(delayMs);
    value = await callApi<unknown>('GET', SETTINGS_UI_RECOMMENDATION_CARS_PATH);
  }
  return value;
};

// A failed or unusable read keeps the last-good state, marked stale.
const staleDismissalRead = (): DismissalReadState => (hasLoadedDismissals(dismissalRead)
  ? { state: 'stale', dismissals: dismissalRead.dismissals }
  : { state: 'unavailable' });

const applyDismissalRead = async (result: PromiseSettledResult<unknown>): Promise<void> => {
  if (result.status === 'rejected') {
    dismissalRead = staleDismissalRead();
    await logSettingsError(
      'Failed to load recommendation acknowledgements',
      result.reason,
      'setup recommendations',
    );
    return;
  }
  const rawDismissals = result.value;
  if (isUnknownRecord(rawDismissals)) {
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
  dismissalRead = staleDismissalRead();
  await logSettingsError(
    'Ignoring unavailable recommendation acknowledgements',
    new TypeError('Invalid recommendation acknowledgement setting.'),
    'setup recommendations',
  );
};

const staleCarInventory = (): CarInventoryState => (carInventory.state === 'resolved' || carInventory.state === 'stale'
  ? { state: 'stale', cars: carInventory.cars }
  : { state: 'unavailable' });

const applyCarInventoryRead = async (result: PromiseSettledResult<unknown>): Promise<void> => {
  if (result.status === 'rejected') {
    carInventory = staleCarInventory();
    await logSettingsError('Failed to load cars for recommendations', result.reason, 'setup recommendations');
    return;
  }
  const parsed = parseCarAssociationCandidatesRead(result.value);
  if (parsed.state === 'resolved') {
    carInventory = { state: 'resolved', cars: parsed.cars };
    return;
  }
  carInventory = staleCarInventory();
};

const runRecommendationAction = (recommendation: SetupRecommendation): void => {
  const { target } = recommendation;
  const task = resolveRecommendationTask(
    target, navigationRead.state === 'resolved' ? navigationRead.navigation : null,
  );
  if (task) {
    if (busyRecommendationId !== null) return;
    busyRecommendationId = recommendation.id;
    refreshRecommendationSurfaces();
    void task.run()
      .catch((error) => showToastError(error, task.failureMessage))
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
  if (target.kind === 'device') navigationRead.navigation.openDevice(target.deviceId, 'top');
  if (target.kind === 'device-start-policy') navigationRead.navigation.openDevice(target.deviceId, 'start-policy');
  if (target.kind === 'device-shed-limit') navigationRead.navigation.openDevice(target.deviceId, 'shed-limit');
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
      offersSolarSetup: resolveSolarSetupOffered(),
      readiness,
      dismissalStatus: hasLoadedDismissals(dismissalRead) ? 'available' : dismissalRead.state,
      retryAvailable: dismissalRead.state === 'unavailable'
        || smartTaskUsageRead === 'unavailable'
        || (anyChargerHasSelectedCar() && ['stale', 'unavailable'].includes(readEvSocFlowReporters().state)),
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
  document.dispatchEvent(new Event('pels:recommendations-updated'));
};

export const refreshAfterSetupRecommendations = async (): Promise<void> => {
  // The setup path's Prices step reads the same price settings; it publishes
  // to the path, which redraws these surfaces on a change.
  await Promise.all([loadAfterSetupFacts(), loadSetupPrices()]);
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

export const refreshCarInventory = (): Promise<void> => {
  carInventoryGeneration += 1;
  refreshRecommendationSurfaces();
  carInventoryRefresh ??= readLatestCarInventory().finally(() => { carInventoryRefresh = undefined; });
  return carInventoryRefresh;
};

// The car list is first read when a device load lands (`devices-updated`), and
// no recommendation resolves before the devices have loaded. So the initial
// data load and later device repaints join that read, or leave it to the device
// load still to come, rather than sending a second request for the same list.
const ensureCarInventory = (): Promise<void> => {
  if (carInventory.state === 'resolved' || (!carInventoryRefresh && !state.devicesLoaded)) return Promise.resolve();
  return carInventoryRefresh ?? refreshCarInventory();
};

const loadRecommendationFlowFacts = async (
  refresh: () => Promise<unknown> = refreshFlowConflictFacts,
): Promise<void> => {
  try {
    await refresh();
  } catch (error) {
    await logSettingsError('Failed to check Homey Flows for recommendations', error, 'setup recommendations');
  }
  refreshRecommendationSurfaces();
};

// Boot and a car selection read the battery-reporting Flows only when they matter.
const loadEvSocReportersIfNeeded = (): Promise<void> => loadRecommendationFlowFacts(refreshEvSocReportersIfNeeded);

export const loadRecommendationData = async (): Promise<void> => {
  await Promise.all([
    loadRecommendationDismissals(),
    loadChargingRecommendations(),
    ensureCarInventory(),
    loadSmartTaskUsage(),
    loadAfterSetupFacts().then(refreshRecommendationSurfaces),
    loadEvSocReportersIfNeeded(),
    // Both publish to the setup path, which redraws these surfaces on a change.
    loadHubMarket(),
    loadSetupPrices(),
  ]);
};

const retryRecommendationData = (): void => {
  const retryDismissals = dismissalRead.state === 'unavailable';
  const retryFlowFacts = ['stale', 'unavailable'].includes(readEvSocFlowReporters().state);
  const retrySmartTaskUsage = smartTaskUsageRead === 'unavailable';
  if (!retryDismissals && !retryFlowFacts && !retrySmartTaskUsage) return;
  if (retryDismissals) dismissalRead = { state: 'loading' };
  if (retrySmartTaskUsage) smartTaskUsageRead = 'loading';
  refreshRecommendationSurfaces();
  void Promise.all([
    retryDismissals ? loadRecommendationDismissals() : Promise.resolve(),
    retryFlowFacts ? loadRecommendationFlowFacts(refreshFlowConflictFactsExplicit) : Promise.resolve(),
    retrySmartTaskUsage ? loadSmartTaskUsage() : Promise.resolve(),
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
  // The device list is an input to every recommendation, so its repaints redraw
  // these surfaces. The car list changes with the runtime's device snapshot,
  // whose `devices_updated` push re-reads it (`realtime.ts`); a repaint only
  // makes sure it has loaded.
  document.addEventListener('devices-updated', () => {
    void ensureCarInventory().then(refreshRecommendationSurfaces);
    void loadChargingRecommendations();
  });
  document.addEventListener('charging-control-changed', () => { void loadChargingRecommendations(true); });
  document.addEventListener('ev-car-associations-updated', loadEvSocReportersIfNeeded);
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
        loadChargingRecommendations(true),
        loadSmartTaskUsage(),
      ]).then(refreshRecommendationSurfaces);
    } else if (panelId === 'overview' || panelId === 'settings') {
      refreshRecommendationSurfaces();
    }
  });
  refreshRecommendationSurfaces();
};

/** Shared by the setup context and the normal recommendation card. */
export const readActiveRecommendation = (id: string): SetupRecommendation | null => {
  if (!hasLoadedDismissals(dismissalRead)) return null;
  return groupSetupRecommendations(resolveCurrentRecommendations(readAfterSetupFacts()), dismissalRead.dismissals)
    .active.find((recommendation) => recommendation.id === id) ?? null;
};

export const dismissSetupRecommendation = (recommendation: SetupRecommendation): Promise<void> => (
  runSerializedDismissalWrite(() => writeDismissal(recommendation, true))
);
