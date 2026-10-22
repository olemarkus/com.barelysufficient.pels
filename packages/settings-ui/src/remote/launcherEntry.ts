import '@material/web/textfield/filled-text-field.js';
import '@material/web/button/filled-button.js';
import '@material/web/button/filled-tonal-button.js';
import '@material/web/button/text-button.js';
import {
  isHomeyApiKey,
  loadStoredHomeys,
  markLastHomey,
  parseHomeyAddress,
  readBrowserStorage,
  removeStoredHomey,
  resolveLanHomeyId,
  saveStoredHomey,
  type StoredHomey,
} from './remoteConnection.ts';
import {
  RemoteHomeyError,
  createRemoteRequest,
  errorDetail,
  isKeyRefused,
  settingPath,
  type RemoteRequest,
} from './remoteHomeyClient.ts';
import {
  buildPathFor,
  decideLaunch,
  readHomeyVersion,
  type LaunchDecision,
} from './launchDecision.ts';

// The web app's start page: the owner's Homeys, each opened in the settings UI
// build made for the PELS version it runs. It never runs PELS UI itself, so it
// works for every PELS version, including ones from before the web app.

type TextField = HTMLElement & { value: string; error: boolean; errorText: string };

// The launcher's own failure, not the Homey's: the list of builds did not load.
type RowStatus = LaunchDecision | { state: 'builds-unavailable' };

const storage = readBrowserStorage();
const fetchImpl = (input: string, init: RequestInit) => window.fetch(input, init);
const params = new URLSearchParams(window.location.search);

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = byId<HTMLUListElement>('webapp-homey-list');
const emptyHint = byId<HTMLElement>('webapp-homeys-empty');
const addPanel = byId<HTMLElement>('webapp-add-panel');
const addForm = byId<HTMLFormElement>('webapp-add-form');
const nameField = addForm.querySelector('[name="name"]') as TextField;
const addressField = addForm.querySelector('[name="address"]') as TextField;
const keyField = addForm.querySelector('[name="key"]') as TextField;

const KEY_NO_LONGER_ACCEPTED = 'Homey no longer accepts the saved key. Paste a new one.';
const STORAGE_REFUSED = 'This browser did not save the Homey. Allow this site to store data, then add it again.';

const setFieldError = (field: TextField, message: string | null) => {
  Object.assign(field, { error: message !== null, errorText: message ?? '' });
};

// Published builds, one per PELS version, listed by the site at publish time.
// Read on every check, so "Check again" sees a build published since.
const loadPublishedVersions = async (): Promise<string[] | null> => {
  try {
    const response = await window.fetch('versions.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const versions: unknown = await response.json();
    return Array.isArray(versions) ? versions.filter((v): v is string => typeof v === 'string') : null;
  } catch {
    return null;
  }
};

const checkHomey = async (homey: StoredHomey): Promise<RowStatus> => {
  const [published, read] = await Promise.all([
    loadPublishedVersions(),
    readHomeyVersion(createRemoteRequest(homey, fetchImpl)),
  ]);
  return published ? decideLaunch(read, published) : { state: 'builds-unavailable' };
};

const statusText = (status: RowStatus | null): string => {
  if (!status) return 'Checking PELS on this Homey…';
  switch (status.state) {
    case 'open':
      return `PELS ${status.version}`;
    case 'update-pels':
      return `The web app does not cover PELS ${status.version}. Update PELS on this Homey to open it here.`;
    case 'predates-web-app':
      return 'This Homey runs a PELS version from before the web app. Update PELS on this Homey to open it here.';
    case 'build-not-published':
      return `PELS ${status.version} is newer than the web app. Try again in a few minutes.`;
    case 'pels-missing':
      return 'PELS is not installed on this Homey.';
    case 'pels-not-running':
      return 'PELS is not running on this Homey. It may be starting; if this stays, check PELS in the Homey app.';
    case 'key-refused':
      return 'This Homey no longer accepts the saved key. Add a new key.';
    case 'unreachable':
      return `This Homey did not answer (${status.detail}).`;
    case 'builds-unavailable':
      return 'The web app could not load its list of builds. Try again in a moment.';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

const openHomey = (homey: StoredHomey, version: string) => {
  markLastHomey(storage, homey.homeyId);
  window.location.assign(buildPathFor(version, homey.homeyId));
};

const showAddPanel = (prefill: { name: string; address: string } | null, keyError: string | null) => {
  addPanel.hidden = false;
  nameField.value = prefill?.name ?? '';
  addressField.value = prefill?.address ?? '';
  keyField.value = '';
  setFieldError(nameField, null);
  setFieldError(addressField, null);
  setFieldError(keyField, keyError);
  addPanel.scrollIntoView({ behavior: 'smooth' });
};

const button = (tag: 'md-filled-tonal-button' | 'md-text-button', label: string, onClick: () => void) => {
  const element = document.createElement(tag);
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
};

const rows = new Map<string, HTMLLIElement>();

const renderRow = (homey: StoredHomey, status: RowStatus | null) => {
  const row = document.createElement('li');
  row.className = 'webapp-homey-row';
  const name = document.createElement('span');
  name.className = 'pels-text-settings-label';
  name.textContent = homey.name;
  const statusLine = document.createElement('p');
  statusLine.className = 'webapp-homey-row__status';
  statusLine.textContent = statusText(status);
  const actions = document.createElement('div');
  actions.className = 'webapp-homey-row__actions';
  if (status?.state === 'open') {
    actions.append(button('md-filled-tonal-button', 'Open', () => openHomey(homey, status.version)));
  } else if (status?.state === 'key-refused') {
    actions.append(button('md-filled-tonal-button', 'Add new key', () => (
      showAddPanel({ name: homey.name, address: homey.baseUrl }, null)
    )));
  } else if (status) {
    actions.append(button('md-text-button', 'Check again', () => {
      void checkAndRender(homey);
    }));
  }
  actions.append(button('md-text-button', 'Remove', () => {
    removeStoredHomey(storage, homey.homeyId);
    void render();
  }));
  row.append(name, statusLine, actions);
  const previous = rows.get(homey.homeyId);
  if (previous) previous.replaceWith(row);
  else list.append(row);
  rows.set(homey.homeyId, row);
};

const checkAndRender = async (homey: StoredHomey): Promise<void> => {
  renderRow(homey, null);
  renderRow(homey, await checkHomey(homey));
};

const render = async () => {
  const { homeys } = loadStoredHomeys(storage);
  rows.clear();
  list.replaceChildren();
  emptyHint.hidden = homeys.length > 0;
  if (homeys.length === 0) {
    showAddPanel(null, null);
    return;
  }
  await Promise.all(homeys.map(checkAndRender));
};

// Homey answers a route PELS does not have with 404 before it looks at the
// key, so the version read cannot vouch for a key on a Homey whose PELS
// predates the web app. Reading an app setting always checks it; an unknown
// setting reads as null, and a missing PELS shows in the list after adding.
const checkApiKey = async (
  request: RemoteRequest,
): Promise<{ state: 'accepted' } | { state: 'key-refused' } | { state: 'unreachable'; detail: string }> => {
  try {
    await request('GET', settingPath('web_app_key_check'));
    return { state: 'accepted' };
  } catch (error) {
    if (isKeyRefused(error)) return { state: 'key-refused' };
    if (error instanceof RemoteHomeyError && error.status === 404) return { state: 'accepted' };
    return { state: 'unreachable', detail: errorDetail(error) };
  }
};

addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    const name = nameField.value.trim();
    setFieldError(nameField, name ? null : 'Give this Homey a name.');
    const address = parseHomeyAddress(addressField.value);
    setFieldError(addressField, address ? null : 'Paste the my.homey.app address or the local address.');
    const token = keyField.value.trim();
    const tokenValid = isHomeyApiKey(token);
    setFieldError(keyField, tokenValid ? null : 'Paste the whole API key.');
    if (!name || !address || !tokenValid) return;

    const homeyId = address.homeyId ?? await resolveLanHomeyId(address.baseUrl);
    if (!homeyId) {
      setFieldError(addressField, 'No Homey answered at this address.');
      return;
    }
    const homey: StoredHomey = { name, baseUrl: address.baseUrl, homeyId, token };
    const keyCheck = await checkApiKey(createRemoteRequest(homey, fetchImpl));
    if (keyCheck.state === 'key-refused') {
      setFieldError(keyField, 'Homey refused this key. Check that it may control apps.');
      return;
    }
    if (keyCheck.state === 'unreachable') {
      setFieldError(addressField, `This Homey did not answer (${keyCheck.detail}).`);
      return;
    }
    if (!saveStoredHomey(storage, homey)) {
      setFieldError(nameField, STORAGE_REFUSED);
      return;
    }
    addPanel.hidden = true;
    await render();
  })();
});

byId<HTMLElement>('webapp-add-homey').addEventListener('click', () => showAddPanel(null, null));

// The installed app starts here and goes straight to a Homey: the one a build
// or the PELS settings page names (`open`), else the one opened last. It stays
// on the list when the owner came to choose, or a build sent them back for a
// new key. A link never fills in the add form: where an API key is sent must
// come from the owner, or a crafted link could collect keys.
const start = async () => {
  const stored = loadStoredHomeys(storage);
  const byHomeyId = (homeyId: string | null) => (
    stored.homeys.find((homey) => homey.homeyId === homeyId) ?? null
  );
  const reauth = byHomeyId(params.get('reauth'));
  // A named Homey that is not listed yet must not fall back to the last one:
  // the owner came to add it.
  const target = params.has('open') ? byHomeyId(params.get('open')) : byHomeyId(stored.lastHomeyId);
  if (!reauth && !params.has('choose') && target) {
    const status = await checkHomey(target);
    if (status.state === 'open') {
      openHomey(target, status.version);
      return;
    }
  }
  await render();
  if (reauth) showAddPanel({ name: reauth.name, address: reauth.baseUrl }, KEY_NO_LONGER_ACCEPTED);
};

void start();
