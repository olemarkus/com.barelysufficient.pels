import { normalizeDeferredObjectiveRoster } from './deferredObjectiveRoster.ts';
import { SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { getApiReadModel } from './homey.ts';
import { bumpPlanSurface } from './planRedesign.ts';
import { state } from './state.ts';

// `state.deferredObjectiveSettings` starts as an empty map, which reads exactly
// like a home with no Smart tasks. A consumer that must not mistake "not loaded
// yet" (or a failed load) for "none configured" asks this first.
let loaded = false;
export const hasLoadedDeferredObjectiveSettings = (): boolean => loaded;

export const loadDeferredObjectiveSettings = async (): Promise<void> => {
  // The runtime assembles the roster from its per-device keys. The bootstrap
  // primes this read model, so the boot load is a cache hit; a per-device key
  // change invalidates it (`settingsChangeRouter.ts`) and the next load fetches.
  const raw = await getApiReadModel<unknown>(SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH);
  state.deferredObjectiveSettings = normalizeDeferredObjectiveRoster(raw);
  loaded = true;
  document.dispatchEvent(new CustomEvent('deferred-objectives-updated'));
  bumpPlanSurface();
};
