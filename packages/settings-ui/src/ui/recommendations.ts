import { SETUP_RECOMMENDATION_DISMISSALS } from '../../../contracts/src/settingsKeys.ts';
import { callApi, getSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import {
  groupSetupRecommendations,
  normalizeRecommendationDismissals,
  parseSupportedCars,
  resolveSetupRecommendations,
  type RecommendationDismissals,
  type SetupRecommendation,
  type SupportedCar,
} from './recommendationsModel.ts';
import { state } from './state.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './deviceDetail/settingsWrite.ts';
import {
  renderSetupRecommendationsBanner,
  renderSetupRecommendationsView,
} from './views/SetupRecommendationsView.tsx';

export type RecommendationNavigation = {
  openPanel: (panelId: string) => void;
  openDevice: (deviceId: string) => void;
};

let dismissals: RecommendationDismissals | null = null;
let cars: SupportedCar[] | null = null;
let navigation: RecommendationNavigation | null = null;
let loadGeneration = 0;
const runSerializedDismissalWrite = createSerializedAsyncRunner();

const getSurfaces = (): { banner: HTMLElement | null; page: HTMLElement | null } => ({
  banner: document.getElementById('setup-recommendations-banner-root'),
  page: document.getElementById('setup-recommendations-root'),
});

const resolveCurrentRecommendations = (): SetupRecommendation[] => {
  if (!state.devicesLoaded || cars === null) return [];
  return resolveSetupRecommendations({
    devices: state.latestDevices,
    cars,
    associations: state.evCarAssociations,
    nativeWiringEnabledByDeviceId: state.nativeWiringMap,
  });
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
  const loaded = dismissals !== null && cars !== null && state.devicesLoaded;
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
    getSetting(SETUP_RECOMMENDATION_DISMISSALS),
    callApi<unknown>('GET', '/homey_devices'),
  ]);
  if (generation !== loadGeneration) return;
  if (dismissalResult.status === 'fulfilled') {
    dismissals = normalizeRecommendationDismissals(dismissalResult.value);
  } else {
    await logSettingsError(
      'Failed to load recommendation acknowledgements',
      dismissalResult.reason,
      'setup recommendations',
    );
  }
  if (carsResult.status === 'fulfilled') {
    const parsed = parseSupportedCars(carsResult.value);
    if (parsed !== null) {
      cars = parsed;
    } else {
      await logSettingsError(
        'Ignoring malformed car list for recommendations',
        new TypeError('Invalid Homey device list response.'),
        'setup recommendations',
      );
    }
  } else {
    await logSettingsError('Failed to load cars for recommendations', carsResult.reason, 'setup recommendations');
  }
  refreshRecommendationSurfaces();
};

export const initRecommendationSurfaces = (nextNavigation: RecommendationNavigation): void => {
  navigation = nextNavigation;
  document.addEventListener('devices-updated', refreshRecommendationSurfaces);
  document.addEventListener('ev-car-associations-updated', refreshRecommendationSurfaces);
  document.addEventListener('pels:tab-shown', (event) => {
    const panelId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId;
    if (panelId === 'recommendations' && (dismissals === null || cars === null)) {
      void loadRecommendationData();
    } else if (panelId === 'overview' || panelId === 'recommendations' || panelId === 'settings') {
      refreshRecommendationSurfaces();
    }
  });
  refreshRecommendationSurfaces();
};
