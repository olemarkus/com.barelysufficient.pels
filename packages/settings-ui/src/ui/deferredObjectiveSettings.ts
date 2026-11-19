import { normalizeDeferredObjectiveRoster } from './deferredObjectiveRoster.ts';
import { SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import { getApiReadModel } from './homey.ts';
import { refreshPlanSurface } from './planSurfaceRefresh.ts';
import { state } from './state.ts';

// `state.deferredObjectiveSettings` starts as an empty map, which reads exactly
// like a home with no Smart tasks. A consumer that must not mistake "not loaded
// yet" (or a failed load) for "none configured" asks this first.
let loadGeneration = 0;
let pendingRead: Promise<void> | undefined;
export const hasLoadedDeferredObjectiveSettings = (): boolean => state.deferredObjectiveSettingsReadState === 'ready';

export const loadDeferredObjectiveSettings = (): Promise<void> => {
  const generation = ++loadGeneration;
  const read = readDeferredObjectiveSettings(generation).finally(() => {
    if (generation === loadGeneration) pendingRead = undefined;
  });
  pendingRead = read;
  return read;
};

export const waitForDeferredObjectiveSettings = async (): Promise<void> => {
  // A superseding reload can start while Review awaits the current one.
  while (pendingRead) {
    await pendingRead.catch(() => undefined);
  }
};

const readDeferredObjectiveSettings = async (generation: number): Promise<void> => {
  // The runtime assembles the roster from its per-device keys. The bootstrap
  // primes this read model, so the boot load is a cache hit; a per-device key
  // change invalidates it (`settingsChangeRouter.ts`) and the next load fetches.
  let raw: unknown;
  try {
    raw = await getApiReadModel<unknown>(SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH);
    if (!isUnknownRecord(raw) || !isUnknownRecord(raw.objectivesByDeviceId)) {
      throw new TypeError('Invalid Smart Task roster.');
    }
  } catch (error) {
    if (generation === loadGeneration && state.deferredObjectiveSettingsReadState !== 'unavailable') {
      state.deferredObjectiveSettingsReadState = 'unavailable';
      document.dispatchEvent(new CustomEvent('deferred-objectives-updated'));
    }
    throw error;
  }
  if (generation !== loadGeneration) return;
  state.deferredObjectiveSettings = normalizeDeferredObjectiveRoster(raw);
  state.deferredObjectiveSettingsReadState = 'ready';
  document.dispatchEvent(new CustomEvent('deferred-objectives-updated'));
  refreshPlanSurface();
};
