// Runtime read site for the `pv_forecast_source` setting: which PV-generation
// forecast feeds planning — Homey Energy's own solar forecast, the learned
// Open-Meteo model, or automatic preference between them.
//
// Read ONCE and HELD. This key is configuration: it changes when the owner
// picks a different forecast, perhaps twice a year, and that change already has
// its own event — the `[PV_FORECAST_SOURCE]` settings handler
// (`lib/utils/settingsHandlers.ts`), which re-resolves the held value. Reading
// it live per consumer call bought nothing on top of that and cost a real
// defect: `homey.settings.get()` can transiently answer nothing for a key that
// IS written, so a live read could silently un-pin an explicit `learned` or
// `homey_energy` choice for one price build. It also cost SDK reads by the
// dozen — the forecast reader runs once per forecast hour inside
// `wireBudgetPrice`, so a day-ahead build asked the SDK 24 times for a value
// that had not changed since boot.
//
// The holder is `HomeySolarForecastController` (`lib/solar`), which already
// remembers and already owns this concept; `setup/` constructs and connects and
// does not remember (`setup/AGENTS.md` § "No state").
//
// ABSENCE vs READ FAILURE, distinguished by observation: an unrecognised raw
// value is either a key nobody has written or one flaky read. Read again. A
// transient miss does not survive the retry; a never-written key answers the
// same nothing twice and legitimately resolves to `'auto'`. The retry lives
// HERE and not in `normalizePvForecastSourceSetting`, because that classifier is
// shared with the settings UI, which reads these bytes over the Homey API
// bridge and has no SDK call to retry.

import {
  isPvForecastSourceSetting,
  normalizePvForecastSourceSetting,
} from '../packages/shared-domain/src/settings/pvForecastSource';
import { PV_FORECAST_SOURCE } from '../lib/utils/settingsKeys';
import type { PvForecastSourceSetting } from '../lib/solar/pvForecastSource';

type SettingsReader = { get: (key: string) => unknown };

/** One raw read, with a throw classified as "nothing came back" — this adapter
 *  owns the complete classification of the SDK's failure modes, so no caller
 *  downstream ever sees a settings exception (root AGENTS.md). */
const readRaw = (settings: SettingsReader): unknown => {
  try {
    return settings.get(PV_FORECAST_SOURCE);
  } catch {
    return undefined;
  }
};

/**
 * Resolve the persisted source, retrying once past an unrecognised read. Called
 * at startup and again from the settings-change handler — never on the hot path.
 */
export function resolvePvForecastSourceSetting(
  settings: SettingsReader,
): PvForecastSourceSetting {
  const first = readRaw(settings);
  if (isPvForecastSourceSetting(first)) return first;
  return normalizePvForecastSourceSetting(readRaw(settings));
}
