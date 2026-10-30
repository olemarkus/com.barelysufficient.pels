export type SettingsUiVersionRead = {
  version: string;
  timeZone: string;
  homeyId: string;
  // Homey's own `ip:port` on the home network, as `ManagerCloud.getLocalAddress`
  // reports it; null when Homey could not say. The web app still reads it
  // defensively, as it does every answer.
  localAddress: string | null;
  // The Homey's own Athom cloud host (`https://<id>.homey.<cluster>.homeypro.net`),
  // which the settings page saves (`web_app_cloud_host`); null before the page
  // has been served from that host. The web app then keeps the address it has.
  cloudHost: string | null;
};

/**
 * Where the hub physically is, as an ISO 3166-1 alpha-2 country code, resolved
 * by the runtime from Homey's own location-derived `country` (it follows the
 * hub's map location, verified 2026-09-20: never the language, never the Athom
 * account). `unavailable` is a read the runtime could not answer or an answer
 * that is not a country code; the UI then shows its market-neutral default.
 *
 * Geography only, on purpose: the settings UI tailors emphasis by market, and a
 * hub's language says nothing reliable about which tariff it lives under.
 */
export type SettingsUiHubMarketRead =
  | { state: 'resolved'; country: string }
  | { state: 'unavailable' };
