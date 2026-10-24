import { getSetting, getSettingFresh, sleep } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { refreshRecommendationSurfaces } from '../recommendations.ts';
import { state } from '../state.ts';
import {
  isShedBehaviorsSetting,
  readShedBehaviors,
} from '../../../../shared-domain/src/settings/shedBehaviors.ts';
import { OVERSHOOT_BEHAVIORS } from '../../../../shared-domain/src/settings/settingsKeys.ts';

// An absent key is the first-run state, no limit saved. A populated key can
// also read null for a moment, so absence counts only once fresh reads a moment
// apart still find no map. Until then nothing is claimed about saved limits.
const SHED_BEHAVIORS_ABSENCE_CONFIRM_DELAYS_MS = [250, 750] as const;
let loadGeneration = 0;

const confirmShedBehaviorsAbsent = async (generation: number): Promise<void> => {
  for (const delayMs of SHED_BEHAVIORS_ABSENCE_CONFIRM_DELAYS_MS) {
    await sleep(delayMs);
    const behaviors = await getSettingFresh(OVERSHOOT_BEHAVIORS);
    // A later load, or the map it read, decides instead: a stale null from
    // this one must not settle "nothing saved" over it.
    if (generation !== loadGeneration || state.shedBehaviorsLoaded) return;
    if (isShedBehaviorsSetting(behaviors)) {
      state.shedBehaviors = readShedBehaviors(behaviors);
      break;
    }
    if (behaviors !== null && behaviors !== undefined) return;
  }
  state.shedBehaviorsLoaded = true;
  refreshRecommendationSurfaces();
};

export const loadShedBehaviors = async () => {
  loadGeneration += 1;
  const generation = loadGeneration;
  try {
    const behaviors = await getSetting(OVERSHOOT_BEHAVIORS);
    // A read that is not the map keeps the one already held.
    if (isShedBehaviorsSetting(behaviors)) {
      state.shedBehaviors = readShedBehaviors(behaviors);
      state.shedBehaviorsLoaded = true;
    } else if (!state.shedBehaviorsLoaded && (behaviors === null || behaviors === undefined)) {
      void confirmShedBehaviorsAbsent(generation).catch((error: unknown) => (
        logSettingsError('Failed to confirm shed behaviors', error, 'loadShedBehaviors')
      ));
    }
  } catch (error) {
    await logSettingsError('Failed to load shed behaviors', error, 'loadShedBehaviors');
  }
};
