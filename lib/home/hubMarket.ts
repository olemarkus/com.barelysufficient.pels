import type { SettingsUiHubMarketRead } from '../../packages/contracts/src/settingsUiApi';

/**
 * Which market the hub lives in, read from Homey's own location-derived
 * `country` on the system manager.
 *
 * A home-level fact, so it lives with the home model. It exists for one reason:
 * the same setup is relevant in different ways in different markets (Flanders
 * bills a 15-minute peak, the Netherlands has no household capacity tariff), and
 * the settings UI may only tailor by where the hub actually is — never by its
 * language. Homey derives `country` from the location the owner set on the map:
 * moving a test hub to Antwerp flipped it to `BE` within seconds.
 *
 * This module owns the whole classification of that read. Absent, malformed and
 * thrown all resolve to `unavailable` here, and nothing downstream sees a raw
 * response.
 */

/**
 * A GET against Homey's Web API, relative to `/api`. Declared here rather than
 * imported because its one other declaration lives in `lib/price`, which a peer
 * domain may not import (`no-home-to-peer`). The consolidated home for it is
 * `lib/ports/`; until a move puts it there, one line duplicated is the honest
 * cost of the boundary.
 */
export type HomeyWebApiGet = (path: string) => Promise<unknown>;

const SYSTEM_MANAGER_PATH = 'manager/system';

const COUNTRY_CODE = /^[A-Z]{2}$/;

const UNAVAILABLE: SettingsUiHubMarketRead = { state: 'unavailable' };

/** Resolve the system manager's weakly-typed response into a country code. */
export const classifyHubMarket = (raw: unknown): SettingsUiHubMarketRead => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return UNAVAILABLE;
  const { country } = raw as { country?: unknown };
  if (typeof country !== 'string') return UNAVAILABLE;
  const code = country.trim().toUpperCase();
  return COUNTRY_CODE.test(code) ? { state: 'resolved', country: code } : UNAVAILABLE;
};

export const readHubMarket = async (get: HomeyWebApiGet): Promise<SettingsUiHubMarketRead> => {
  try {
    return classifyHubMarket(await get(SYSTEM_MANAGER_PATH));
  } catch {
    return UNAVAILABLE;
  }
};
