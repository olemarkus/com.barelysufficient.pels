import { readHubMarket } from '../../lib/home/hubMarket';
import { readSettingsUiVersion } from '../../lib/app/settingsUiVersion';
import type {
  SettingsUiHubMarketRead,
  SettingsUiVersionRead,
} from '../../packages/contracts/src/settingsUi/webApp';
import { createHomeyWebApiGet } from '../homeyWebApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const webAppRoutes = defineRoutes({
  // Answers without the runtime being wired, so the web app can pick its build
  // while PELS is still starting. `lib/app` owns the reads.
  ui_version: ({ homey }: ApiContext): Promise<SettingsUiVersionRead> => readSettingsUiVersion(homey),
  // Where the hub is, from Homey's location-derived `country`. `lib/home` owns the
  // read and resolves every failure to `unavailable`, so this never throws and
  // never blocks the settings UI: it asks once, after its first paint.
  ui_hub_market: (): Promise<SettingsUiHubMarketRead> => readHubMarket(createHomeyWebApiGet()),
});
