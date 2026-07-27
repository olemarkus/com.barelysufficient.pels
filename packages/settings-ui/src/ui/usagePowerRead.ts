import { MAIN_HOME_ID } from '../../../contracts/src/settingsKeys.ts';
import { resolveHomeScopedRead, type HomeScopedRead } from '../../../contracts/src/homeScopedRead.ts';
import { SETTINGS_UI_POWER_PATH, type SettingsUiPowerPayload } from '../../../contracts/src/settingsUiApi.ts';
import { getApiReadModel, homeScopedApiUri } from './homey.ts';
import { getHomeScope } from './homeScope.ts';
import { logSettingsError } from './logging.ts';

/**
 * The Usage surface's scope-following `ui_power` read (multi-home).
 *
 * Main selection keeps the historical whole-home request byte for byte: the
 * BARE `/ui_power` URI and the same `apiCache` entry every existing
 * invalidation site sweeps. The untyped Homey callback answer must be a
 * complete unscoped power envelope before it is served; nullish, partial, or
 * scoped answers are unavailable rather than fabricated Main-home data.
 *
 * A selected meter area reads the `?homeId=` variant and MUST discriminate the
 * producer's `homeScope` before any flat field: the scoped endpoints answer
 * every non-serving case with the empty shape plus `unavailable`, so an
 * undiscriminated read would render fabricated zeros as that area's history.
 * `resolveHomeScopedRead` makes the flat fields unreachable until then, and
 * also verifies the resolved id IS the requested one — a misrouted payload
 * resolved for another home would otherwise render that home's figures under
 * this area's chip.
 *
 * BOTH branches own the complete classification of their read — a THROWN
 * fetch included (root AGENTS.md, "Validation belongs at the boundary").
 * Letting a rejection propagate would abort the caller's render pass before
 * the honest-state flip: an area→Main switch with a cold bare cache would
 * leave Main's chip sitting over the previous area's figures. A read the
 * runtime could not answer IS the `unavailable` state.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasOwn = (value: Record<string, unknown>, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
);

const isMainPowerPayload = (value: unknown): value is SettingsUiPowerPayload => {
  if (!isRecord(value) || hasOwn(value, 'homeScope')) return false;
  if (!hasOwn(value, 'tracker') || !hasOwn(value, 'status') || !hasOwn(value, 'heartbeat')) return false;
  if (value.tracker !== null && !isRecord(value.tracker)) return false;
  if (value.status !== null && !isRecord(value.status)) return false;
  if (value.heartbeat !== null && (typeof value.heartbeat !== 'number' || !Number.isFinite(value.heartbeat))) {
    return false;
  }
  return value.hasManagedSolarDevice === undefined || typeof value.hasManagedSolarDevice === 'boolean';
};

export const readUsagePower = async (): Promise<HomeScopedRead<SettingsUiPowerPayload>> => {
  const { selectedHomeId } = getHomeScope();
  if (selectedHomeId === MAIN_HOME_ID) {
    try {
      const payload = await getApiReadModel<unknown>(SETTINGS_UI_POWER_PATH);
      return isMainPowerPayload(payload) ? { state: 'served', payload } : { state: 'unavailable' };
    } catch (caught) {
      void logSettingsError('Failed to read the whole home\'s power data', caught, 'usagePowerRead');
      return { state: 'unavailable' };
    }
  }
  try {
    return resolveHomeScopedRead(
      await getApiReadModel<SettingsUiPowerPayload>(
        homeScopedApiUri(SETTINGS_UI_POWER_PATH, selectedHomeId),
      ),
      selectedHomeId,
    );
  } catch (caught) {
    void logSettingsError('Failed to read the meter area\'s power data', caught, 'usagePowerRead');
    return { state: 'unavailable' };
  }
};
