import { SETTINGS_UI_VERSION_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { type SettingsUiVersionRead } from '../../../contracts/src/settingsUi/webApp.ts';
import { readWebAppCloudHost } from '../../../shared-domain/src/settings/webAppCloudHost.ts';
import { localUrlFromAddress } from './homeyAddress.ts';
import { PELS_APP_ID } from './remoteConnection.ts';
import {
  RemoteHomeyError,
  errorDetail,
  isKeyRefused,
  type RemoteRequest,
} from './remoteHomeyClient.ts';

// What one Homey said when asked for its PELS version, other than a version.
type HomeyVersionProblem =
  // PELS answered, but has no `ui_version` route: it predates the web app.
  | { state: 'predates-web-app' }
  | { state: 'pels-missing' }
  // Installed but not running: starting, stopped or crashed.
  | { state: 'pels-not-running' }
  | { state: 'key-refused' }
  | { state: 'unreachable'; detail: string };

export type HomeyVersionRead =
  // `localUrl` and `cloudHost` are null when the Homey offered no usable
  // home-network address or cloud host (`SettingsUiVersionRead`).
  | { state: 'version'; version: string; timeZone: string; localUrl: string | null; cloudHost: string | null }
  | HomeyVersionProblem;

// The launcher talks to every PELS version that has the route, so only the
// version and zone are required and each address is read on its own.
type VersionAnswer = Pick<SettingsUiVersionRead, 'version' | 'timeZone'> & {
  localAddress?: unknown;
  cloudHost?: unknown;
};

const isVersionRead = (value: unknown): value is VersionAnswer => (
  typeof value === 'object' && value !== null
  && typeof (value as Partial<Record<keyof SettingsUiVersionRead, unknown>>).version === 'string'
  && typeof (value as Partial<Record<keyof SettingsUiVersionRead, unknown>>).timeZone === 'string'
);

// A cloud host is taken only when it is this Homey's own, as everywhere else.
export const readHomeyVersion = async (request: RemoteRequest, homeyId: string): Promise<HomeyVersionRead> => {
  try {
    const read = await request('GET', `/api/app/${PELS_APP_ID}${SETTINGS_UI_VERSION_PATH}`);
    return isVersionRead(read)
      ? {
        state: 'version',
        version: read.version,
        timeZone: read.timeZone,
        localUrl: localUrlFromAddress(read.localAddress),
        cloudHost: readWebAppCloudHost(read.cloudHost, homeyId),
      }
      : { state: 'unreachable', detail: 'unexpected version answer' };
  } catch (error) {
    if (isKeyRefused(error)) return { state: 'key-refused' };
    if (error instanceof RemoteHomeyError && error.status === 404) {
      // An installed app answers an unknown route with Express's "Cannot GET";
      // an app that is not installed is refused by Homey itself.
      return /^Cannot GET /.test(error.message) ? { state: 'predates-web-app' } : { state: 'pels-missing' };
    }
    // Homey answers for an installed app that is not running with 503.
    if (error instanceof RemoteHomeyError && error.status === 503) return { state: 'pels-not-running' };
    return { state: 'unreachable', detail: errorDetail(error) };
  }
};

export type LaunchDecision =
  | { state: 'open'; version: string }
  // The Homey runs a version the web app has no build for.
  | { state: 'update-pels'; version: string }
  // A release newer than every published build: its build is not online yet.
  | { state: 'build-not-published'; version: string }
  | HomeyVersionProblem;

const parseVersion = (version: string): number[] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
};

const compareVersions = (left: number[], right: number[]): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

// Each published build is the settings UI of exactly one PELS version, so a
// Homey opens only the build of the version it runs. A version newer than every
// build is a release whose build is not online yet; any other gap is a version
// the web app does not serve, which the owner fixes by updating PELS.
export const decideLaunch = (read: HomeyVersionRead, publishedVersions: readonly string[]): LaunchDecision => {
  if (read.state !== 'version') return read;
  if (publishedVersions.includes(read.version)) return { state: 'open', version: read.version };
  const running = parseVersion(read.version);
  const sorted = publishedVersions
    .map(parseVersion)
    .filter((version): version is number[] => version !== null)
    .sort(compareVersions);
  const newest = sorted[sorted.length - 1];
  if (running && newest && compareVersions(running, newest) > 0) {
    return { state: 'build-not-published', version: read.version };
  }
  return { state: 'update-pels', version: read.version };
};

export const buildPathFor = (version: string, homeyId: string): string => (
  `v${version}/#homey=${encodeURIComponent(homeyId)}`
);
