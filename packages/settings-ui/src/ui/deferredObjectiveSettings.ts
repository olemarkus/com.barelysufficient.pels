import { normalizeDeferredObjectiveSettings } from '../../../contracts/src/deferredObjectiveSettings.ts';
import { DEFERRED_OBJECTIVES_SETTINGS } from '../../../contracts/src/settingsKeys.ts';
import { SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { callApi, getSetting, hasSettingCache } from './homey.ts';
import { bumpPlanSurface } from './planRedesign.ts';
import { state } from './state.ts';

export const loadDeferredObjectiveSettings = async (): Promise<void> => {
  // Objectives live in per-device keys now; the raw `deferred_objectives` blob is
  // consumed by the boot migration. On the normal boot path the bootstrap injected
  // the assembled per-key map and primed the settings cache under this alias, so a
  // CACHE HIT serves it with no extra network call. Otherwise — the bootstrap-failure
  // fallback, OR after the realtime handler invalidated the alias on a per-device
  // change — fetch the freshly-assembled map from the endpoint. We deliberately read
  // cache-only (not `getSetting`, which would fall through to a Homey `get` of the
  // consumed/stale legacy blob) so a cache miss always goes to the endpoint.
  const raw = hasSettingCache(DEFERRED_OBJECTIVES_SETTINGS)
    ? await getSetting(DEFERRED_OBJECTIVES_SETTINGS)
    : await callApi<unknown>('GET', SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH);
  state.deferredObjectiveSettings = normalizeDeferredObjectiveSettings(raw);
  bumpPlanSurface();
};
