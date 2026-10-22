import io from 'socket.io-client';
import '../ui/materialWeb.ts';
import { boot } from '../ui/boot.ts';
import type { HomeySettingsClient } from '../ui/homey.ts';
import {
  findStoredHomey,
  loadStoredHomeys,
  markLastHomey,
  pickBuildHomeyId,
  readBrowserStorage,
  type StoredHomey,
} from './remoteConnection.ts';
import {
  createRemoteEventHub,
  createRemoteHomeyClient,
  createRemoteRequest,
} from './remoteHomeyClient.ts';
import { connectRemoteRealtime } from './remoteRealtime.ts';
import { createSettingsResync } from './remoteSettingsResync.ts';
import { readHomeyVersion } from './launchDecision.ts';

// One published build of the web app: the settings UI of exactly one PELS
// version, with the WebView's injected `Homey` replaced by a client that talks
// to Homey's Web API with the owner's API key. The launcher one level up owns
// the Homey list and picks this build for Homeys that run this version.

declare const __PELS_WEB_APP_VERSION__: string;

type WindowWithReady = Window & { onHomeyReady?: (homey: HomeySettingsClient) => void };

const LAUNCHER = '../';
const TAB_HOMEY_KEY = 'pels.webapp.tabHomey';

const fetchImpl = (input: string, init: RequestInit) => window.fetch(input, init);

const readTabHomeyId = (): string | null => {
  try {
    return window.sessionStorage.getItem(TAB_HOMEY_KEY);
  } catch {
    return null;
  }
};

const rememberTabHomey = (homeyId: string) => {
  try {
    window.sessionStorage.setItem(TAB_HOMEY_KEY, homeyId);
  } catch {
    // This tab falls back to the Homey opened last.
  }
};

// The Homey this page shows, with a way back to the list of Homeys.
const renderHomeyBar = (homey: StoredHomey) => {
  const bar = document.createElement('div');
  bar.className = 'webapp-homey-bar';
  const name = document.createElement('span');
  name.className = 'webapp-homey-bar__name';
  name.textContent = homey.name;
  const switcher = document.createElement('md-text-button');
  switcher.setAttribute('href', `${LAUNCHER}?choose`);
  switcher.textContent = 'Switch Homey';
  bar.append(name, switcher);
  document.body.prepend(bar);
};

const start = async () => {
  const storage = readBrowserStorage();
  const fragmentHomeyId = new URLSearchParams(window.location.hash.slice(1)).get('homey');
  const homeyId = pickBuildHomeyId(fragmentHomeyId, readTabHomeyId(), loadStoredHomeys(storage));
  const homey = homeyId ? findStoredHomey(storage, homeyId) : null;
  if (!homey) {
    window.location.replace(`${LAUNCHER}?choose`);
    return;
  }
  const request = createRemoteRequest(homey, fetchImpl);
  // Only this build's own version opens here. A Homey that did not answer
  // still opens, to the UI's own connection errors and retries; anything else
  // (PELS updated since, removed, stopped, or the key deleted) goes back to the
  // launcher, which keeps this Homey selected.
  const read = await readHomeyVersion(request);
  if (read.state === 'key-refused') {
    window.location.replace(`${LAUNCHER}?reauth=${encodeURIComponent(homey.homeyId)}`);
    return;
  }
  const opens = read.state === 'unreachable'
    || (read.state === 'version' && read.version === __PELS_WEB_APP_VERSION__);
  if (!opens) {
    window.location.replace(`${LAUNCHER}?open=${encodeURIComponent(homey.homeyId)}`);
    return;
  }
  markLastHomey(storage, homey.homeyId);
  rememberTabHomey(homey.homeyId);
  renderHomeyBar(homey);

  const events = createRemoteEventHub();
  const client = createRemoteHomeyClient(
    request,
    events,
    // A Homey that did not answer opens to the UI's own connection errors;
    // until it answers, the browser's zone is the only one known.
    read.state === 'version' ? read.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const resync = createSettingsResync(request, events.dispatch);
  connectRemoteRealtime(
    homey,
    (baseUrl) => io(baseUrl, { transports: ['websocket'], autoConnect: false }),
    (event, data) => {
      if ((event === 'settings.set' || event === 'settings.unset') && typeof data === 'string') {
        resync.onSettingsEvent(data);
      }
      events.dispatch(event, data);
    },
    (status) => {
      // Exposed for debugging and tests.
      document.documentElement.dataset.webappRealtime = status;
      resync.onStatus(status);
    },
  );
  (window as WindowWithReady).onHomeyReady?.(client);
  await boot();
};

void start();
