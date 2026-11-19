import {
  chargingRecommendationStatus, currentChargingAdvice, loadChargingRecommendations,
} from './chargingRecommendationRead.ts';
import { registerOverviewRecommendationDismissals } from './overviewControlWarnings.ts';
import { type SettingsUiRecommendationCar } from '../../../contracts/src/settingsUi/carLink.ts';
import {
  SETTINGS_UI_PRICES_PATH,
  SETTINGS_UI_POWER_PATH, SETTINGS_UI_RECOMMENDATION_CARS_PATH,
} from '../../../contracts/src/settingsUi/paths.ts';
import {
  callApi, coldStartReadRetryDelays, getHomeyTimezone, getSetting, getSettingFresh,
  invalidateApiCache, sleep,
} from './homey.ts';
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
import { state } from './state.ts';
import { readDeferredObjectiveHistory } from './deferredObjectiveHistoryRead.ts';
import { recordSmartTaskHistoryDevices } from './smartTaskUsage.ts';
import { resolveDeviceSettingRecommendations } from './deviceSettingRecommendations.ts';
import { notifySetupPathChange, onSetupPathChange, readSetupPath } from './setupPathFacts.ts';
import {
  loadAfterSetupFacts,
  loadDailyDiagnosticsReport,
  readAfterSetupFacts,
  type AfterSetupFactsRead,
} from './afterSetupFacts.ts';
import { resolveAfterSetupRecommendations } from './afterSetupRecommendations.ts';
import { loadHubMarket } from './hubMarket.ts';
import { loadSetupPrices } from './setupPricesLoad.ts';
import { formatSetupProgress } from './setupPathModel.ts';
import {
  anyChargerHasSelectedCar, loadEvCarAssociations, readCarAssociationStatus,
} from './deviceDetail/carAssociation.ts';
import { createSerializedAsyncRunner, readRecordSetting, writeFreshSetting } from './deviceDetail/settingsWrite.ts';
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
import { readHomeMembership, refreshHomeScopeAndNotify, subscribeToHomeScope } from './homeScope.ts';
import {
  loadHardCapReachFacts,
  readHardCapReachFacts, readHardCapReachStatus,
  resolveHardCapReachRecommendations,
} from './hardCapReachRecommendation.ts';

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
  | { state: 'resolved'; navigation: RecommendationNavigation; retrySetupPath: () => Promise<void> };

type RecommendationReadiness = 'loading' | 'checking' | 'partial' | 'resolved';

type LoadedDismissalReadState = Extract<DismissalReadState, { state: 'resolved' | 'stale' }>;

let dismissalRead: DismissalReadState = { state: 'loading' };
let carInventory: CarInventoryState = { state: 'loading' };
const carChecksComplete = (): boolean => carInventory.state === 'resolved'
  && carInventory.cars.every((car) => car.matchHistory.state === 'resolved');

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
    const history = await readDeferredObjectiveHistory('recommendations');
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
  if (!state.devicesLoaded) return state.devicesReadState === 'unavailable' ? 'partial' : 'loading';
  const inventory = carInventory.state === 'resolved' && !carChecksComplete() ? 'unavailable' : carInventory.state;
  let afterSetup: 'loading' | 'resolved' | 'unavailable' = afterSetupRead.state;
  if (afterSetupRead.state === 'resolved') {
    if (afterSetupRead.checksIncomplete) afterSetup = 'unavailable';
    else if (afterSetupRead.checksPending) afterSetup = 'loading';
  }
  const checks = [
    inventory, readCarAssociationStatus(), smartTaskUsageRead, readHardCapReachStatus(), afterSetup,
    chargingRecommendationStatus(),
    anyChargerHasSelectedCar() ? readEvSocFlowReporters().state : 'resolved',
  ];
  if (checks.includes('unavailable') || checks.includes('stale') || dismissalRead.state === 'stale') return 'partial';
  return checks.includes('loading') ? 'checking' : 'resolved';
};

const getSurfaces = (): { banner: HTMLElement | null; page: HTMLElement | null } => ({
  banner: document.getElementById('setup-recommendations-banner-root'),
  page: document.getElementById('setup-recommendations-root'),
});

const resolveCurrentRecommendations = (
  afterSetupRead: AfterSetupFactsRead,
  dismissals: RecommendationDismissals,
): SetupRecommendation[] => {
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
  // What PELS can do next first: an owner who has just finished setup needs a
  // job for PELS before device tuning, and in a home with no limit to hold,
  // prices, solar and Smart tasks are that job. Then the fixes for managed
  // devices, by name. A device PELS does not manage gets none: its wiring,
  // its car and its Flows are not PELS's to set up until the owner chooses it.
  const managed = state.latestDevices.filter((device) => state.managedMap[device.id] === true);
  return [
    ...(afterSetupRead.state === 'resolved'
      ? resolveAfterSetupRecommendations(afterSetupRead.facts, dismissals)
      : []),
    ...currentChargingAdvice(managed),
    ...resolveSetupRecommendations(
      managed,
      cars,
      state.evCarAssociations,
      state.nativeWiringMap,
      evSocReporters,
    ),
    ...resolveDeviceSettingRecommendations(),
    ...resolveHardCapReachRecommendations(
      readHardCapReachStatus() === 'resolved' ? readHardCapReachFacts() : null, Date.now(), getHomeyTimezone(),
    ),
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
  if (target.kind === 'setup-goals') {
    navigationRead.navigation.openPanel('devices', 'goals');
    return;
  }
  if (target.kind === 'panel') {
    navigationRead.navigation.openPanel(target.panelId);
    return;
  }
  navigationRead.navigation.openPanel('devices');
  if (target.kind === 'device') navigationRead.navigation.openDevice(target.deviceId, target.focus ?? 'top');
  if (target.kind === 'device-start-policy') navigationRead.navigation.openDevice(target.deviceId, 'start-policy');
  if (target.kind === 'device-shed-limit') navigationRead.navigation.openDevice(target.deviceId, 'shed-limit');
  if (target.kind === 'device-control-model') navigationRead.navigation.openDevice(target.deviceId, 'control-model');
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
  const groups = groupSetupRecommendations(resolveCurrentRecommendations(afterSetupRead, dismissals), dismissals);
  const attention = coreLoaded ? groups.active.filter((recommendation) => !recommendation.waitsOnPage) : [];
  if (banner) {
    renderSetupRecommendationsBanner(banner, {
      active: attention,
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
    const hasSuggestions = attention.length > 0;
    chip.hidden = setupRead.state !== 'open' && !hasSuggestions;
    if (setupRead.state === 'open') chip.textContent = formatSetupProgress(setupRead.path);
    else if (hasSuggestions) chip.textContent = String(attention.length);
  }
  if (page) {
    renderSetupRecommendationsView(page, {
      ...groups,
      setupPath: setupRead,
      readiness,
      dismissalStatus: hasLoadedDismissals(dismissalRead) ? 'available' : dismissalRead.state,
      devicesUnavailable: state.devicesReadState === 'unavailable',
      retryAvailable: readiness === 'partial' || dismissalRead.state === 'unavailable',
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

/** The daily report setting changed: re-read only it, so no price read holds the card. */
export const refreshDailyReportSuggestion = async (): Promise<void> => {
  await loadDailyDiagnosticsReport();
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
    loadChargingRecommendations(refreshRecommendationSurfaces),
    ensureCarInventory(),
    loadSmartTaskUsage(),
    loadAfterSetupFacts().then(refreshRecommendationSurfaces),
    loadHardCapReachFacts().then(refreshRecommendationSurfaces),
    loadEvSocReportersIfNeeded(),
    // Both publish to the setup path, which redraws these surfaces on a change.
    loadHubMarket(),
    loadSetupPrices(),
  ]);
};

export const refreshHardCapRecommendation = async (): Promise<void> => {
  await loadHardCapReachFacts();
  refreshRecommendationSurfaces();
};

const retryAfterSetupChecks = async (setupUnavailable: boolean): Promise<void> => {
  invalidateApiCache(SETTINGS_UI_PRICES_PATH);
  const reads = [refreshAfterSetupRecommendations()];
  if (setupUnavailable && navigationRead.state === 'resolved') {
    reads.push(navigationRead.retrySetupPath());
  }
  await Promise.all(reads);
};

const refreshCarAndFlowChecks = async (onVisit: boolean): Promise<void> => {
  if (readCarAssociationStatus() !== 'resolved') await loadEvCarAssociations();
  if (onVisit || (anyChargerHasSelectedCar() && readEvSocFlowReporters().state !== 'resolved')) {
    await loadRecommendationFlowFacts(onVisit ? refreshFlowConflictFacts : refreshFlowConflictFactsExplicit);
  }
};

const refreshChargerChecks = async (onVisit: boolean): Promise<void> => {
  const reads = [refreshCarAndFlowChecks(onVisit)];
  if (onVisit || !carChecksComplete()) reads.push(refreshCarInventory());
  if (onVisit || chargingRecommendationStatus() !== 'resolved') {
    reads.push(loadChargingRecommendations(refreshRecommendationSurfaces, true));
  }
  await Promise.all(reads);
};

const shouldRefreshAfterSetupChecks = (onVisit: boolean): boolean => {
  const facts = readAfterSetupFacts();
  switch (facts.state) {
    case 'unavailable': return true;
    case 'resolved': return facts.checksIncomplete === true;
    case 'loading': return !onVisit;
    default: return false;
  }
};

// A visit refreshes facts that may have changed elsewhere. An explicit retry
// requests only the missing checks, bypassing cached unavailable payloads.
const refreshPageChecks = async (onVisit: boolean): Promise<void> => {
  const setupUnavailable = readSetupPath().state === 'unavailable';
  const hardCapStatus = readHardCapReachStatus();
  if (setupUnavailable || hardCapStatus === 'unavailable') invalidateApiCache(SETTINGS_UI_POWER_PATH);
  const reads: Promise<unknown>[] = [];
  if (state.devicesReadState === 'unavailable') document.dispatchEvent(new Event('request-load-devices'));
  if (readHomeMembership().state === 'unavailable') reads.push(refreshHomeScopeAndNotify());
  if (dismissalRead.state !== 'resolved') reads.push(loadRecommendationDismissals());
  reads.push(refreshChargerChecks(onVisit));
  if (onVisit || smartTaskUsageRead !== 'resolved') reads.push(loadSmartTaskUsage());
  if (onVisit || hardCapStatus !== 'resolved') reads.push(refreshHardCapRecommendation());
  if (setupUnavailable || shouldRefreshAfterSetupChecks(onVisit)) reads.push(retryAfterSetupChecks(setupUnavailable));
  await Promise.all(reads);
  refreshRecommendationSurfaces();
};

let retryInFlight: Promise<void> | undefined;
const retryRecommendationData = (): void => {
  retryInFlight ??= refreshPageChecks(false).finally(() => { retryInFlight = undefined; });
};

export const clearRecommendationDismissals = (): void => {
  loadGeneration += 1;
  dismissalRevision += 1;
  dismissalRead = { state: 'resolved', dismissals: {} };
  refreshRecommendationSurfaces();
};

export const initRecommendationSurfaces = (
  navigation: RecommendationNavigation, retrySetupPath: () => Promise<void>,
): void => {
  navigationRead = { state: 'resolved', navigation, retrySetupPath };
  registerOverviewRecommendationDismissals({
    read: (recommendation) => {
      if (dismissalRead.state === 'loading') return 'loading';
      if (!hasLoadedDismissals(dismissalRead)) return 'unavailable';
      return dismissalRead.dismissals[recommendation.id] === recommendation.version ? 'dismissed' : 'active';
    },
    dismiss: dismissSetupRecommendation,
  });
  // Recommendation applicability depends on the identities of Main-home
  // devices, not only on the setup path's aggregate counts.
  subscribeToHomeScope(refreshRecommendationSurfaces);
  // The device list is an input to every recommendation, so its repaints redraw
  // these surfaces. The car list changes with the runtime's device snapshot,
  // whose `devices_updated` push re-reads it (`realtime.ts`); a repaint only
  // makes sure it has loaded.
  document.addEventListener('devices-updated', () => {
    void ensureCarInventory().then(refreshRecommendationSurfaces);
    void loadChargingRecommendations(refreshRecommendationSurfaces);
  });
  document.addEventListener('charging-control-changed', () => {
    void loadChargingRecommendations(refreshRecommendationSurfaces, true);
  });
  document.addEventListener('ev-car-associations-updated', loadEvSocReportersIfNeeded);
  onSetupPathChange(refreshRecommendationSurfaces);
  // The device list is one of the path's facts, and it lands without any of the
  // path's publishers being involved. Gated inside: a tick that leaves the path
  // unchanged redraws nothing.
  document.addEventListener('devices-updated', notifySetupPathChange);
  // A Smart task added or cleared elsewhere changes whether one is suggested.
  document.addEventListener('deferred-objectives-updated', refreshRecommendationSurfaces);
  document.addEventListener('pels:tab-shown', (event) => {
    if (!(event instanceof CustomEvent) || !isUnknownRecord(event.detail)) return;
    const panelId = event.detail.tabId;
    if (panelId === 'recommendations') {
      void refreshPageChecks(true);
    } else if (panelId === 'overview' || panelId === 'settings') {
      refreshRecommendationSurfaces();
    }
  });
  refreshRecommendationSurfaces();
};

/** Shared by the setup context and the normal recommendation card. */
export const readActiveRecommendation = (id: string): SetupRecommendation | null => {
  if (!hasLoadedDismissals(dismissalRead)) return null;
  const { dismissals } = dismissalRead;
  return groupSetupRecommendations(resolveCurrentRecommendations(readAfterSetupFacts(), dismissals), dismissals)
    .active.find((recommendation) => recommendation.id === id) ?? null;
};

export const dismissSetupRecommendation = (recommendation: SetupRecommendation): Promise<void> => (
  runSerializedDismissalWrite(() => writeDismissal(recommendation, true))
);
