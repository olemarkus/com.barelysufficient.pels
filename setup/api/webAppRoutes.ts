import { readHubMarket } from '../../lib/home/hubMarket';
import type {
  SettingsUiHubMarketRead,
  SettingsUiVersionRead,
} from '../../packages/contracts/src/settingsUiApi';
import { WEB_APP_CLOUD_HOST } from '../../packages/shared-domain/src/settings/settingsKeys';
import { readWebAppCloudHost } from '../../packages/shared-domain/src/settings/webAppCloudHost';
import { createHomeyWebApiGet } from '../homeyWebApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const webAppRoutes = defineRoutes({
  // Answers without the runtime being wired, so the web app can pick its build
  // while PELS is still starting.
  ui_version: async ({ homey }: ApiContext): Promise<SettingsUiVersionRead> => {
    const { version } = homey.manifest as { version?: unknown };
    if (typeof version !== 'string') throw new Error('The app manifest has no version');
    const homeyId = await homey.cloud.getHomeyId();
    return {
      version,
      timeZone: homey.clock.getTimezone(),
      homeyId,
      // Lets the web app reach this Homey on the home network instead of
      // through the cloud. Without it the web app keeps using the cloud, so a
      // failed read must not fail the version answer.
      localAddress: await homey.cloud.getLocalAddress().catch(() => null),
      // Lets the web app leave Athom's rate-limited relay for the Homey's own
      // cloud host, which the settings page saves when served from it.
      cloudHost: readWebAppCloudHost(homey.settings.get(WEB_APP_CLOUD_HOST), homeyId),
    };
  },
  // Where the hub is, from Homey's location-derived `country`. `lib/home` owns the
  // read and resolves every failure to `unavailable`, so this never throws and
  // never blocks the settings UI: it asks once, after its first paint.
  ui_hub_market: (): Promise<SettingsUiHubMarketRead> => readHubMarket(createHomeyWebApiGet()),
});
