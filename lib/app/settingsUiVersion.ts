import type { SettingsUiVersionRead } from '../../packages/contracts/src/settingsUi/webApp';
import { WEB_APP_CLOUD_HOST } from '../../packages/shared-domain/src/settings/settingsKeys';
import { readWebAppCloudHost } from '../../packages/shared-domain/src/settings/webAppCloudHost';
import type { SettingsPort } from '../ports/homeyRuntime';

/**
 * The slice of `homey` the version answer reads: the app manifest, the hub's
 * identity and addresses, its time zone, and the cloud host the settings page
 * saved. Every member exists from the moment Homey hands the app its handle,
 * so the answer needs no running PELS.
 */
export type SettingsUiVersionSource = {
  readonly manifest: unknown;
  readonly cloud: {
    getHomeyId(): Promise<string>;
    getLocalAddress(): Promise<string>;
  };
  readonly clock: { getTimezone(): string };
  readonly settings: Pick<SettingsPort, 'get'>;
};

const readManifestVersion = (manifest: unknown): string => {
  const version = typeof manifest === 'object' && manifest !== null && 'version' in manifest
    ? manifest.version
    : undefined;
  if (typeof version !== 'string') throw new Error('The app manifest has no version');
  return version;
};

/**
 * What the standalone web app needs to pick its settings UI build and reach
 * this Homey. Answers while PELS is still starting.
 */
export const readSettingsUiVersion = async (homey: SettingsUiVersionSource): Promise<SettingsUiVersionRead> => {
  const version = readManifestVersion(homey.manifest);
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
};
