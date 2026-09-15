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
  type SupportedCar,
} from './recommendationsModel.ts';
import { state } from './state.ts';
import { loadEvCarAssociations } from './deviceDetail/carAssociation.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './deviceDetail/settingsWrite.ts';
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

let dismissals: RecommendationDismissals | null = null;
let cars: SupportedCar[] | null = null;
let navigation: RecommendationNavigation | null = null;
let loadGeneration = 0;
let carInventoryUnavailable = false;
const runSerializedDismissalWrite = createSerializedAsyncRunner();
const RECOMMENDATION_READ_RETRY_DELAYS_MS = [250, 750] as const;

const getSurfaces = (): { banner: HTMLElement | null; page: HTMLElement | null } => ({
  banner: document.getElementById('setup-recommendations-banner-root'),
  page: document.getElementById('setup-recommendations-root'),
});

const resolveCurrentRecommendations = (): SetupRecommendation[] => {
  if (!state.devicesLoaded || !state.evCarAssociationsLoaded || cars === null) return [];
  return resolveSetupRecommendations(
    state.latestDevices,
    cars,
    state.evCarAssociations,
    state.nativeWiringMap,
  );
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
    if (parseRecommendationCarsRead(value)?.state !== 'unavailable') break;
    await sleep(delayMs);
    value = await callApi<unknown>('GET', SETTINGS_UI_RECOMMENDATION_CARS_PATH);
  }
  return value;
};

const applyDismissalRead = async (result: PromiseSettledResult<unknown>): Promise<void> => {
  if (result.status === 'rejected') {
    await logSettingsError(
      'Failed to load recommendation acknowledgements',
      result.reason,
      'setup recommendations',
    );
    return;
  }
  const rawDismissals = result.value;
  if (isDismissalRecord(rawDismissals)) {
    dismissals = normalizeRecommendationDismissals(rawDismissals);
    return;
  }
  if (dismissals === null && (rawDismissals === null || rawDismissals === undefined)) {
    // An absent key is the normal first-run state. Once a last-good map exists,
    // the same SDK result is treated as unavailable and remains a no-op.
    dismissals = {};
    return;
  }
  await logSettingsError(
    'Ignoring unavailable recommendation acknowledgements',
    new TypeError('Invalid recommendation acknowledgement setting.'),
    'setup recommendations',
  );
};

const applyCarInventoryRead = async (result: PromiseSettledResult<unknown>): Promise<void> => {
  if (result.status === 'rejected') {
    carInventoryUnavailable = true;
    await logSettingsError('Failed to load cars for recommendations', result.reason, 'setup recommendations');
    return;
  }
  const parsed = parseRecommendationCarsRead(result.value);
  if (parsed === null) {
    carInventoryUnavailable = true;
    await logSettingsError(
      'Ignoring malformed car list for recommendations',
      new TypeError('Invalid recommendation car response.'),
      'setup recommendations',
    );
    return;
  }
  carInventoryUnavailable = parsed.state === 'unavailable';
  if (parsed.state === 'resolved') cars = parsed.cars;
};

const openRecommendationTarget = (recommendation: SetupRecommendation): void => {
  if (!navigation) return;
  navigation.openPanel('devices');
  if (recommendation.target.kind === 'device') {
    navigation.openDevice(recommendation.target.deviceId);
  }
};

const writeDismissal = async (recommendation: SetupRecommendation, dismissed: boolean): Promise<void> => {
  await writeFreshSetting<RecommendationDismissals>({
    key: SETUP_RECOMMENDATION_DISMISSALS,
    context: 'setup recommendations',
    logMessage: 'Failed to update recommendation acknowledgement',
    toastMessage: 'Failed to update the recommendation.',
    fallbackValue: dismissals ?? {},
    readFresh: (value) => (
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? normalizeRecommendationDismissals(value)
        : null
    ),
    mutate: (current) => {
      const next = { ...current };
      if (dismissed) next[recommendation.id] = recommendation.version;
      else delete next[recommendation.id];
      return next;
    },
    commit: (next) => {
      dismissals = next;
      refreshRecommendationSurfaces();
    },
    rollback: refreshRecommendationSurfaces,
  });
};

export const refreshRecommendationSurfaces = (): void => {
  const { banner, page } = getSurfaces();
  const loaded = dismissals !== null
    && cars !== null
    && state.devicesLoaded
    && state.evCarAssociationsLoaded;
  const groups = groupSetupRecommendations(resolveCurrentRecommendations(), dismissals ?? {});
  if (banner) {
    renderSetupRecommendationsBanner(banner, {
      count: loaded ? groups.active.length : 0,
      onOpen: () => navigation?.openPanel('recommendations'),
    });
  }
  const chip = document.getElementById('settings-nav-chip-recommendations');
  if (chip) {
    chip.hidden = !loaded || groups.active.length === 0;
    if (loaded && groups.active.length > 0) chip.textContent = String(groups.active.length);
  }
  if (page) {
    renderSetupRecommendationsView(page, {
      ...groups,
      loaded,
      onAction: openRecommendationTarget,
      onDismiss: (recommendation) => {
        void runSerializedDismissalWrite(() => writeDismissal(recommendation, true));
      },
      onRestore: (recommendation) => {
        void runSerializedDismissalWrite(() => writeDismissal(recommendation, false));
      },
    });
  }
};

export const loadRecommendationData = async (): Promise<void> => {
  loadGeneration += 1;
  const generation = loadGeneration;
  const [dismissalResult, carsResult] = await Promise.allSettled([
    loadDismissalSetting(),
    loadRecommendationCars(),
  ]);
  if (generation !== loadGeneration) return;
  await applyDismissalRead(dismissalResult);
  if (generation !== loadGeneration) return;
  await applyCarInventoryRead(carsResult);
  if (generation !== loadGeneration) return;
  refreshRecommendationSurfaces();
};

export const clearRecommendationDismissals = (): void => {
  loadGeneration += 1;
  dismissals = {};
  refreshRecommendationSurfaces();
};

export const initRecommendationSurfaces = (nextNavigation: RecommendationNavigation): void => {
  navigation = nextNavigation;
  document.addEventListener('devices-updated', refreshRecommendationSurfaces);
  document.addEventListener('ev-car-associations-updated', refreshRecommendationSurfaces);
  document.addEventListener('pels:tab-shown', (event) => {
    const panelId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
    if (panelId === 'recommendations' && (
      dismissals === null
      || cars === null
      || carInventoryUnavailable
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
