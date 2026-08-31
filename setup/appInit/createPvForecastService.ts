// Wiring for the learned PV-generation forecast: binds the Homey-shaped seams —
// the settings-backed store and the hub's coordinates — to the controller that
// owns the behaviour (`lib/solar/pvForecastController.ts`), then starts it.
//
// The controller used to live here, holding its timers, its dormancy latch and
// its boot-trust state machine in the wiring layer. Those are runtime state, so
// they moved to the domain that owns the concept; what stays is construction
// (`setup/AGENTS.md` § "No state").

import {
  PvForecastController,
  PV_FORECAST_USER_AGENT,
} from '../../lib/solar/pvForecastController';
import { createPvForecastStore } from '../pvForecastStateAdapter';
import { readHubCoordinates } from '../homeyLocationAdapter';
import { getLogger } from '../../lib/logging/logger';
import type { AppContext } from '../../lib/app/appContext';

export { PvForecastController, type PvForecastLogger } from '../../lib/solar/pvForecastController';

/**
 * Construct AND start the PV-forecast controller from the app context: it records
 * gross generation fed from the power pipeline plus Open-Meteo irradiance, learns
 * the device gain, and forecasts forward solar output. Pure data — it never touches
 * shed/capacity decisions; no-op until positive generation is seen.
 */
export function createPvForecastController(ctx: AppContext): PvForecastController {
  const controller = new PvForecastController({
    store: createPvForecastStore(ctx.homey),
    userAgent: PV_FORECAST_USER_AGENT,
    getNowMs: () => Date.now(),
    readCoordinates: readHubCoordinates,
    logger: getLogger('solar'),
  });
  controller.start();
  return controller;
}
