import {
  SETTINGS_UI_RECOMMENDATION_CARS_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import { callApi, getSetting, getSettingFresh, sleep } from './homey.ts';
import { logSettingsError } from './logging.ts';
import {
  groupSetupRecommendations,
  normalizeRecommendationDismissals,
  parseRecommendationCarsRead,
  resolveCarAssociationRecommendations,
  resolveNativeControlRecommendations,
  type RecommendationDismissals,
  type SetupRecommendation,
} from './recommendationsModel.ts';
import type { SettingsUiRecommendationCar } from '../../../contracts/src/settingsUiApi.ts';
import { state } from './state.ts';
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

type RecommendationReadiness = 'loading' | 'unavailable' | 'partial' | 'resolved';

type LoadedDismissalReadState = Extract<DismissalReadState, { state: 'resolved' | 'stale' }>;

let dismissalRead: DismissalReadState = { state: 'loading' };
let carInventory: CarInventoryState = { state: 'loading' };
let navigationRead: NavigationState = { state: 'uninitialized' };
let loadGeneration = 0;
let dismissalRevision = 0;
const runSerializedDismissalWrite = createSerializedAsyncRunner();
const RECOMMENDATION_READ_RETRY_DELAYS_MS = [250, 750] as const;

const hasLoadedDismissals = (read: DismissalReadState): read is LoadedDismissalReadState => (
  read.state === 'resolved' || read.state === 'stale'
);

const resolveRecommendationReadiness = (read: DismissalReadState): RecommendationReadiness => {
  if (read.state === 'unavailable') return 'unavailable';
  if (!hasLoadedDismissals(read) || !state.devicesLoaded) return 'loading';
  return read.state === 'resolved'
    && state.evCarAssociationsLoaded
    && carInventory.state === 'resolved'
    ? 'resolved'
    : 'partial';
};

const getSurfaces = (): { banner: HTMLElement | null; page: HTMLElement | null } => ({
  banner: document.getElementById('setup-recommendations-banner-root'),
  page: document.getElementById('setup-recommendations-root'),
});

const resolveCurrentRecommendations = (): SetupRecommendation[] => {
  if (!state.devicesLoaded) return [];
  const nativeRecommendations = resolveNativeControlRecommendations(state.latestDevices, state.nativeWiringMap);
  const carRecommendations = state.evCarAssociationsLoaded
    && (carInventory.state === 'resolved' || carInventory.state === 'stale')
    ? resolveCarAssociationRecommendations(state.latestDevices, carInventory.cars, state.evCarAssociations)
    : [];
  return [...nativeRecommendations, ...carRecommendations]
    .sort((left, right) => left.title.localeCompare(right.title));
};

const isDismissalRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const loadDismissalSetting = async (): Promise<unknown> => {
  let value = await getSetting(SETUP_RECOMMENDATION_DISMISSALS);
  for (const delayMs of RECOMMENDATION_READ_RETRY_DELAYS_MS) {
    if (value !== null && value !== undefined) break;
    await sleep(delayMs);
    value = await getSettingFresh(SETUP_RECOMMENDATION_DISMISSALS);
  }
  return value;
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

const openRecommendationTarget = (recommendation: SetupRecommendation): void => {
  if (navigationRead.state !== 'resolved') return;
  navigationRead.navigation.openPanel('devices');
  if (recommendation.target.kind === 'device') {
    navigationRead.navigation.openDevice(recommendation.target.deviceId);
  }
};

const writeDismissal = async (recommendation: SetupRecommendation, dismissed: boolean): Promise<void> => {
  await writeFreshSetting<RecommendationDismissals>({
    key: SETUP_RECOMMENDATION_DISMISSALS,
    context: 'setup recommendations',
    logMessage: 'Failed to update recommendation acknowledgement',
    toastMessage: 'Failed to update the recommendation.',
    fallbackValue: dismissalRead.state === 'resolved' || dismissalRead.state === 'stale'
      ? dismissalRead.dismissals
      : {},
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
  const hasDismissals = hasLoadedDismissals(dismissalRead);
  const coreLoaded = hasDismissals && state.devicesLoaded;
  const readiness = resolveRecommendationReadiness(dismissalRead);
  const dismissals = hasLoadedDismissals(dismissalRead) ? dismissalRead.dismissals : {};
  const groups = groupSetupRecommendations(resolveCurrentRecommendations(), dismissals);
  if (banner) {
    renderSetupRecommendationsBanner(banner, {
      count: coreLoaded ? groups.active.length : 0,
      onOpen: () => {
        if (navigationRead.state === 'resolved') navigationRead.navigation.openPanel('recommendations');
      },
    });
  }
  const chip = document.getElementById('settings-nav-chip-recommendations');
  if (chip) {
    chip.hidden = !coreLoaded || groups.active.length === 0;
    if (coreLoaded && groups.active.length > 0) chip.textContent = String(groups.active.length);
  }
  if (page) {
    renderSetupRecommendationsView(page, {
      ...groups,
      readiness,
      onAction: openRecommendationTarget,
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

export const loadRecommendationData = async (): Promise<void> => {
  loadGeneration += 1;
  const generation = loadGeneration;
  const dismissalRevisionAtStart = dismissalRevision;
  const [dismissalResult, carsResult] = await Promise.allSettled([
    loadDismissalSetting(),
    loadRecommendationCars(),
  ]);
  if (generation !== loadGeneration) return;
  if (dismissalRevisionAtStart === dismissalRevision) {
    await applyDismissalRead(dismissalResult);
  }
  if (generation !== loadGeneration) return;
  await applyCarInventoryRead(carsResult);
  if (generation !== loadGeneration) return;
  refreshRecommendationSurfaces();
};

const retryRecommendationData = (): void => {
  if (dismissalRead.state !== 'unavailable') return;
  dismissalRead = { state: 'loading' };
  refreshRecommendationSurfaces();
  void loadRecommendationData();
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
  document.addEventListener('devices-updated', refreshRecommendationSurfaces);
  document.addEventListener('ev-car-associations-updated', refreshRecommendationSurfaces);
  document.addEventListener('pels:tab-shown', (event) => {
    const panelId = readTabId(event);
    if (panelId === 'recommendations' && (
      dismissalRead.state !== 'resolved'
      || carInventory.state === 'loading'
      || carInventory.state === 'unavailable'
      || carInventory.state === 'stale'
      || !state.evCarAssociationsLoaded
    )) {
      const associationLoad = state.evCarAssociationsLoaded
        ? Promise.resolve()
        : loadEvCarAssociations();
      void Promise.all([loadRecommendationData(), associationLoad]).then(refreshRecommendationSurfaces);
    } else if (panelId === 'overview' || panelId === 'recommendations' || panelId === 'settings') {
      refreshRecommendationSurfaces();
    }
  });
  refreshRecommendationSurfaces();
};
