import { normalizeDeferredObjectiveSettings } from '../../../contracts/src/deferredObjectiveSettings.ts';
import { DEFERRED_OBJECTIVES_SETTINGS } from '../../../contracts/src/settingsKeys.ts';
import { getSetting } from './homey.ts';
import { bumpPlanSurface } from './planRedesign.ts';
import { state } from './state.ts';

export const loadDeferredObjectiveSettings = async (): Promise<void> => {
  const raw = await getSetting(DEFERRED_OBJECTIVES_SETTINGS);
  state.deferredObjectiveSettings = normalizeDeferredObjectiveSettings(raw);
  bumpPlanSurface();
};
