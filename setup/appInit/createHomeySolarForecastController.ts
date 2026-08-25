// Wiring for Homey Energy's solar production forecast (firmware 13.4.0+):
// binds the controller's outward seams — the classifying fetch adapter, the
// clock, the Homey timezone, the persisted source setting, and the learned
// lane's arm signal — and starts it.
//
// The controller itself lives in `lib/solar/homeySolarForecastController.ts`
// because it remembers (probe latches, last outcome); setup constructs and
// connects, and does not (`setup/AGENTS.md` § "No state").

import {
  HomeySolarForecastController,
} from '../../lib/solar/homeySolarForecastController';
import { resolvePvForecastSourceSetting } from '../pvForecastSourceSetting';
import { fetchSolarForecastDay } from '../homeyEnergySolarForecastAdapter';
import { getLogger } from '../../lib/logging/logger';
import type { AppContext } from '../../lib/app/appContext';

/**
 * Construct AND start the Homey solar-forecast controller from the app context.
 * Pure data — it never touches shed/capacity decisions.
 */
export function createHomeySolarForecastController(
  ctx: AppContext,
  isLearnedActive: () => boolean,
): HomeySolarForecastController {
  const controller = new HomeySolarForecastController({
    fetchForecastDay: fetchSolarForecastDay,
    getTimeZone: () => ctx.getTimeZone(),
    getNowMs: () => Date.now(),
    readSourceSetting: () => resolvePvForecastSourceSetting(ctx.homey.settings),
    isLearnedActive,
    logger: getLogger('solar'),
  });
  controller.start();
  return controller;
}
