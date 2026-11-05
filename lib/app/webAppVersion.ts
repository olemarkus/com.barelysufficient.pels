import type { WebAppRuntime } from '../ports/homeyRuntime';
import type { SettingsUiVersionRead } from '../../packages/contracts/src/settingsUi/webApp';
import { WEB_APP_CLOUD_HOST } from '../../packages/shared-domain/src/settings/settingsKeys';
import { readWebAppCloudHost } from '../../packages/shared-domain/src/settings/webAppCloudHost';

/** The standalone UI needs its build and connection identity before runtime startup. */
export async function readWebAppVersion(homey: WebAppRuntime): Promise<SettingsUiVersionRead> {
  const { version } = homey.manifest;
  if (typeof version !== 'string') throw new Error('The app manifest has no version');
  const homeyId = await homey.cloud.getHomeyId();
  return {
    version,
    timeZone: homey.clock.getTimezone(),
    homeyId,
    // A missing local address leaves the existing cloud route usable.
    localAddress: await homey.cloud.getLocalAddress().catch(() => null),
    cloudHost: readWebAppCloudHost(homey.settings.get(WEB_APP_CLOUD_HOST), homeyId),
  };
}
