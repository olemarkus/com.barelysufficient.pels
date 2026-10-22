import '@material/web/textfield/filled-text-field.js';
import '@material/web/button/filled-button.js';
import '@material/web/button/filled-tonal-button.js';
import '@material/web/button/text-button.js';
import {
  HOMEY_ID_PATTERN,
  cloudAddressFor,
  cloudAnswers,
  parseHomeyAddress,
  pingHomeyId,
  relayUrl,
  type HomeyAddress,
} from './homeyAddress.ts';
import {
  findStoredHomey,
  isHomeyApiKey,
  learnCloudUrl,
  learnLocalUrl,
  loadStoredHomeys,
  markLastHomey,
  readBrowserStorage,
  MAX_HOMEY_NAME_LENGTH,
  removeStoredHomey,
  saveStoredHomey,
  saveStoredHomeys,
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
import { drawPairingCodes } from './pairingCodes.ts';
import { readPairing, type PairingRead } from './phonePairing.ts';
import {
  chooseAddress,
  createRemoteTarget,
  handOverAddress,
  type AddressChoice,
} from './remoteTarget.ts';

// The web app's start page: the owner's Homeys, each opened in the settings UI
// build made for the PELS version it runs. It never runs PELS UI itself, so it
// works for every PELS version, including ones from before the web app.

type TextField = HTMLElement & { value: string; error: boolean; errorText: string; supportingText: string };

type RowStatus =
  | LaunchDecision
  // The launcher's own failure, not the Homey's: the list of builds did not load.
  | { state: 'builds-unavailable' }
  // Homey's cloud refused calls for a moment; the check waits and tries again.
  | { state: 'busy' };

const storage = readBrowserStorage();
const fetchImpl = (input: string, init: RequestInit) => window.fetch(input, init);
const params = new URLSearchParams(window.location.search);

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = byId<HTMLUListElement>('webapp-homey-list');
const emptyHint = byId<HTMLElement>('webapp-homeys-empty');
const phoneLead = byId<HTMLElement>('webapp-phone-lead');
const homeysPanel = byId<HTMLElement>('webapp-homeys-panel');
const addTitle = byId<HTMLElement>('webapp-add-title');
const addSubmit = byId<HTMLElement & { disabled: boolean }>('webapp-add-submit');
const addCancel = byId<HTMLElement>('webapp-add-cancel');
const installButton = byId<HTMLElement>('webapp-install');
const addPanel = byId<HTMLElement>('webapp-add-panel');
const addForm = byId<HTMLFormElement>('webapp-add-form');
const nameField = addForm.querySelector('[name="name"]') as TextField;
const addressField = addForm.querySelector('[name="address"]') as TextField;
const keyField = addForm.querySelector('[name="key"]') as TextField;
const pairButton = byId<HTMLElement>('webapp-pair-phone');
const pairPanel = byId<HTMLElement>('webapp-pair-panel');
const pairCodes = byId<HTMLElement>('webapp-pair-codes');
const importPanel = byId<HTMLElement>('webapp-import-panel');
const importText = byId<HTMLElement>('webapp-import-text');
const importTitle = byId<HTMLElement>('webapp-import-title');
const importCancel = byId<HTMLElement>('webapp-import-cancel');
const importAdd = byId<HTMLElement>('webapp-import-add');

// A Homey added by its home-network address names itself on a ping, and a
// linked cloud address must answer before it is kept.
const ADDRESS_CHECK_TIMEOUT_MS = 10_000;
const BUSY = 'Homey\'s cloud connection is busy. Trying again…';
const UNREACHABLE = 'This Homey could not be reached. Check that it is online, then check again.';

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

// One check of a listed Homey, with the address it answered on and what it
// taught about itself (the home-network address it reports).
type HomeyCheck = { homey: StoredHomey; address: AddressChoice; status: RowStatus };

const checkHomey = async (homey: StoredHomey, onBusy: (busy: boolean) => void): Promise<HomeyCheck> => {
  const readVersion = async () => {
    const target = createRemoteTarget(homey, await chooseAddress(homey, fetchImpl));
    return { target, read: await readHomeyVersion(createRemoteRequest(target, fetchImpl, onBusy)) };
  };
  const [published, { target, read }] = await Promise.all([loadPublishedVersions(), readVersion()]);
  const learned = (read.state === 'version' ? learnLocalUrl(storage, homey.homeyId, read.localUrl) : null) ?? homey;
  return {
    homey: learned,
    // A home-network address the Homey has just reported is tried before
    // opening, so the first session can use it too.
    address: learned.localUrl === homey.localUrl ? target.address() : await chooseAddress(learned, fetchImpl),
    status: published ? decideLaunch(read, published) : { state: 'builds-unavailable' },
  };
};

const statusText = (status: RowStatus | null): string => {
  if (!status) return 'Checking PELS on this Homey…';
  switch (status.state) {
    case 'open':
      return `PELS ${status.version}`;
    case 'update-pels':
      return `The web app has no build for PELS ${status.version}. Update PELS on this Homey to open it here.`;
    case 'predates-web-app':
      return 'This Homey runs a PELS version from before the web app. Update PELS on this Homey to open it here.';
    case 'build-not-published':
      return `PELS ${status.version} is newer than the web app. Check again in a few minutes.`;
    case 'pels-missing':
      return 'PELS is not installed on this Homey.';
    case 'pels-not-running':
      return 'PELS is not running on this Homey. If it is starting, check again in a minute; otherwise restart PELS '
        + 'in the Homey app.';
    case 'key-refused':
      return 'This Homey no longer accepts the saved key. Add a new key.';
    case 'unreachable':
      return UNREACHABLE;
    case 'builds-unavailable':
      return 'The web app could not load its list of builds. Check again in a moment.';
    case 'busy':
      return BUSY;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

const openHomey = (homey: StoredHomey, version: string, address: AddressChoice) => {
  markLastHomey(storage, homey.homeyId);
  handOverAddress(homey.homeyId, address === 'local' && homey.localUrl !== null ? homey.localUrl : homey.baseUrl);
  window.location.assign(buildPathFor(version, homey.homeyId));
};

// The add form, or the same form asking for a new key for a listed Homey.
const showAddPanel = (rekey: StoredHomey | null) => {
  addPanel.hidden = false;
  addTitle.textContent = rekey ? `New key for ${rekey.name}` : 'Add a Homey';
  addSubmit.textContent = rekey ? 'Save key' : 'Add';
  addCancel.hidden = loadStoredHomeys(storage).homeys.length === 0;
  nameField.value = rekey?.name ?? '';
  addressField.value = rekey?.baseUrl ?? '';
  keyField.value = '';
  setFieldError(nameField, null);
  setFieldError(addressField, null);
  setFieldError(keyField, null);
  addPanel.scrollIntoView({ behavior: 'smooth' });
};

const button = (tag: 'md-filled-tonal-button' | 'md-text-button', label: string, onClick: () => void) => {
  const element = document.createElement(tag);
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
};

const rows = new Map<string, HTMLLIElement>();

// Removing forgets the only copy of the key in this browser, and Homey shows
// a key just once, so it is confirmed in the row first.
const confirmRemoval = (row: HTMLElement, homey: StoredHomey, actions: HTMLElement) => {
  const question = document.createElement('p');
  question.className = 'webapp-homey-row__status';
  question.textContent = `Remove ${homey.name} from this browser? Adding it again takes a new API key.`;
  const confirm = document.createElement('div');
  confirm.className = 'webapp-homey-row__actions';
  confirm.append(
    button('md-filled-tonal-button', 'Remove', () => {
      removeStoredHomey(storage, homey.homeyId);
      void render();
    }),
    button('md-text-button', 'Keep', () => {
      question.replaceWith(actions);
      confirm.remove();
    }),
  );
  actions.replaceWith(question);
  row.append(confirm);
};

const rowAction = (homey: StoredHomey, status: RowStatus | null, address: AddressChoice): HTMLElement | null => {
  if (status?.state === 'open') {
    return button('md-filled-tonal-button', 'Open', () => openHomey(homey, status.version, address));
  }
  if (status?.state === 'key-refused') {
    return button('md-filled-tonal-button', 'Add new key', () => showAddPanel(homey));
  }
  if (status && status.state !== 'busy') {
    return button('md-text-button', 'Check again', () => {
      void checkAndRender(homey);
    });
  }
  return null;
};

const renderRow = (homey: StoredHomey, status: RowStatus | null, address: AddressChoice) => {
  const row = document.createElement('li');
  row.className = 'webapp-homey-row';
  const name = document.createElement('span');
  name.className = 'pels-text-settings-label';
  name.textContent = homey.name;
  const statusLine = document.createElement('p');
  statusLine.className = 'webapp-homey-row__status';
  statusLine.classList.toggle(
    'webapp-homey-row__status--problem',
    status !== null && status.state !== 'open' && status.state !== 'busy',
  );
  statusLine.textContent = statusText(status);
  const actions = document.createElement('div');
  actions.className = 'webapp-homey-row__actions';
  const action = rowAction(homey, status, address);
  if (action) actions.append(action);
  actions.append(button('md-text-button', 'Remove', () => confirmRemoval(row, homey, actions)));
  row.append(name, statusLine, actions);
  const previous = rows.get(homey.homeyId);
  if (previous) previous.replaceWith(row);
  else list.append(row);
  rows.set(homey.homeyId, row);
};

const checkAndRender = async (homey: StoredHomey): Promise<HomeyCheck> => {
  renderRow(homey, null, 'cloud');
  const check = await checkHomey(homey, (busy) => renderRow(homey, busy ? { state: 'busy' } : null, 'cloud'));
  renderRow(check.homey, check.status, check.address);
  return check;
};

const render = async () => {
  const { homeys } = loadStoredHomeys(storage);
  rows.clear();
  list.replaceChildren();
  emptyHint.hidden = homeys.length > 0;
  phoneLead.hidden = homeys.length > 0;
  pairButton.hidden = homeys.length === 0;
  // A code drawn for the list as it was would still carry a removed key.
  pairCodes.replaceChildren();
  pairPanel.hidden = true;
  if (homeys.length === 0) {
    showAddPanel(null);
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

// The Homey an added address and key describe. A cloud address names its
// Homey; a home-network address is asked. A new key for a listed Homey keeps
// the addresses learned for it.
const homeyFromForm = async (address: HomeyAddress, name: string, token: string): Promise<StoredHomey | null> => {
  if (address.kind === 'cloud') {
    const listed = findStoredHomey(storage, address.homeyId);
    return { name, homeyId: address.homeyId, token, baseUrl: address.baseUrl, localUrl: listed?.localUrl ?? null };
  }
  const homeyId = await pingHomeyId(address.baseUrl, fetchImpl, ADDRESS_CHECK_TIMEOUT_MS);
  if (!homeyId) return null;
  const listed = findStoredHomey(storage, homeyId);
  return { name, homeyId, token, baseUrl: listed?.baseUrl ?? relayUrl(homeyId), localUrl: address.baseUrl };
};

const addHomey = async () => {
  const name = nameField.value.trim();
  const nameError = name.length > MAX_HOMEY_NAME_LENGTH
    ? `Keep the name to ${MAX_HOMEY_NAME_LENGTH} characters.`
    : 'Give this Homey a name.';
  setFieldError(nameField, name && name.length <= MAX_HOMEY_NAME_LENGTH ? null : nameError);
  const address = parseHomeyAddress(addressField.value);
  setFieldError(addressField, address ? null : 'Use the address from PELS Settings → Open in a browser, or this '
    + 'Homey\'s page in the Homey web app. An IP address alone does not work.');
  const token = keyField.value.trim();
  const tokenValid = isHomeyApiKey(token);
  setFieldError(keyField, tokenValid ? null : 'Paste the whole API key.');
  if (!name || name.length > MAX_HOMEY_NAME_LENGTH || !address || !tokenValid) return;

  const homey = await homeyFromForm(address, name, token);
  if (!homey) {
    setFieldError(addressField, 'No Homey answered at this address.');
    return;
  }
  const target = createRemoteTarget(homey, address.kind);
  const keyCheck = await checkApiKey(createRemoteRequest(target, fetchImpl, (busy) => {
    addressField.supportingText = busy ? BUSY : '';
  }));
  if (keyCheck.state === 'key-refused') {
    setFieldError(keyField, 'Homey refused this key. Check that it has permission to control apps.');
    return;
  }
  if (keyCheck.state === 'unreachable') {
    setFieldError(addressField, 'This Homey could not be reached. Check that it is online, then try again.');
    return;
  }
  if (!saveStoredHomey(storage, homey)) {
    setFieldError(nameField, STORAGE_REFUSED);
    return;
  }
  addPanel.hidden = true;
  await render();
};

// One addition at a time: a second submit while Homey is still being asked
// would race the first one's messages and its save. The button says it is
// waiting, which can take a while through a busy cloud.
let adding = false;
addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (adding) return;
  adding = true;
  const label = addSubmit.textContent;
  addSubmit.disabled = true;
  addSubmit.textContent = 'Checking…';
  void addHomey().finally(() => {
    adding = false;
    addSubmit.disabled = false;
    addSubmit.textContent = label;
  });
});
addCancel.addEventListener('click', () => {
  addPanel.hidden = true;
});

byId<HTMLElement>('webapp-add-homey').addEventListener('click', () => showAddPanel(null));

// Installing is offered where the browser offers it (Chrome on Android and
// computers); it then lives on the home screen and opens the last Homey.
type InstallPrompt = Event & { prompt: () => Promise<unknown> };
let installPrompt: InstallPrompt | null = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event as InstallPrompt;
  installButton.hidden = false;
});
installButton.addEventListener('click', () => {
  installButton.hidden = true;
  void installPrompt?.prompt();
  installPrompt = null;
});

// The code for the phone, removed again once the owner is done with it or the
// list changes.
pairButton.addEventListener('click', () => {
  const launcher = new URL('./', window.location.href).href;
  pairCodes.replaceChildren(...drawPairingCodes(launcher, loadStoredHomeys(storage).homeys));
  pairPanel.hidden = false;
  pairPanel.scrollIntoView({ behavior: 'smooth' });
});
byId<HTMLElement>('webapp-pair-done').addEventListener('click', () => {
  pairCodes.replaceChildren();
  pairPanel.hidden = true;
});

// On the phone: the Homeys a code carried, added only once the owner agrees.
// A code could come from someone else, so a key in it replaces a key saved
// here only once that Homey accepts it, and a Homey already listed keeps the
// addresses learned for it. Everything goes in one write.
let pairedHomeys: StoredHomey[] = [];

type PairedOutcome = { state: 'add'; homey: StoredHomey } | { state: 'key-refused' } | { state: 'unreachable' };

const mergePaired = async (homey: StoredHomey): Promise<PairedOutcome> => {
  const listed = findStoredHomey(storage, homey.homeyId);
  if (!listed) return { state: 'add', homey };
  const merged: StoredHomey = {
    ...homey,
    baseUrl: listed.baseUrl === relayUrl(listed.homeyId) ? homey.baseUrl : listed.baseUrl,
    localUrl: listed.localUrl,
  };
  if (homey.token === listed.token) return { state: 'add', homey: merged };
  const check = await checkApiKey(createRemoteRequest(createRemoteTarget(merged, 'cloud'), fetchImpl, () => {}));
  return check.state === 'accepted' ? { state: 'add', homey: merged } : check;
};

// Both outcomes keep the key saved here; only the reason differs.
const keptKeyText = (paired: readonly StoredHomey[], outcomes: readonly PairedOutcome[]): string => {
  const named = (state: PairedOutcome['state']) => paired
    .filter((_homey, index) => outcomes[index]?.state === state)
    .map((homey) => homey.name)
    .join(', ');
  return [
    named('key-refused')
      ? `Kept the key saved here for ${named('key-refused')}: Homey refused the key in the code.`
      : '',
    named('unreachable')
      ? `Kept the key saved here for ${named('unreachable')}: that Homey could not be reached. Scan the code again to `
        + 'retry.'
      : '',
  ].filter(Boolean).join(' ');
};

const closeOffer = () => {
  importPanel.hidden = true;
  homeysPanel.hidden = false;
  void render();
};

const offerPairedHomeys = (pairing: Exclude<PairingRead, { state: 'none' }>) => {
  addPanel.hidden = true;
  homeysPanel.hidden = loadStoredHomeys(storage).homeys.length === 0;
  importPanel.hidden = false;
  importAdd.hidden = pairing.state !== 'homeys';
  if (pairing.state !== 'homeys') {
    importTitle.textContent = 'This code could not be read';
    importCancel.textContent = 'Close';
    importText.textContent = 'Show it again on the other device and scan it once more.';
    return;
  }
  pairedHomeys = pairing.homeys;
  const rekeyed = pairing.homeys
    .filter((homey) => (findStoredHomey(storage, homey.homeyId)?.token ?? homey.token) !== homey.token)
    .map((homey) => homey.name);
  importText.textContent = [
    `Homeys in this code: ${pairing.homeys.map((homey) => homey.name).join(', ')}.`,
    rekeyed.length > 0
      ? `The key saved here for ${rekeyed.join(', ')} is replaced once Homey accepts the new one.`
      : '',
    'Add them only if the code came from your own computer or phone; this browser keeps their API keys.',
  ].filter(Boolean).join(' ');
};

importAdd.addEventListener('click', () => {
  importAdd.hidden = true;
  void (async () => {
    const outcomes = await Promise.all(pairedHomeys.map(mergePaired));
    const added = outcomes.flatMap((outcome) => (outcome.state === 'add' ? [outcome.homey] : []));
    if (!saveStoredHomeys(storage, added)) {
      importText.textContent = STORAGE_REFUSED;
      importAdd.hidden = false;
      return;
    }
    const kept = keptKeyText(pairedHomeys, outcomes);
    if (!kept) {
      closeOffer();
      return;
    }
    importTitle.textContent = 'Some keys were kept';
    importText.textContent = kept;
    importCancel.textContent = 'Close';
    homeysPanel.hidden = false;
    await render();
  })();
});
importCancel.addEventListener('click', closeOffer);

// The Homey web app's API Keys page for the Homey the owner came to add or
// re-key, when a link names it; the Homey web app's start page otherwise.
const pointToApiKeys = () => {
  const homeyId = params.get('reauth') ?? params.get('open');
  if (!homeyId || !HOMEY_ID_PATTERN.test(homeyId)) return;
  byId<HTMLAnchorElement>('webapp-api-keys-link').href = (
    `https://my.homey.app/homeys/${homeyId.toLowerCase()}/settings/system/api-keys`
  );
};

// The PELS settings page links here with its own cloud host (`via`), which
// Homey's web app serves it from. A listed Homey switches to that host once it
// answers; anything but an Athom host named for that Homey is ignored.
const learnLinkedCloudAddress = async () => {
  const homeyId = params.get('open');
  const listed = homeyId ? findStoredHomey(storage, homeyId) : null;
  const cloudUrl = listed ? cloudAddressFor(params.get('via') ?? '', listed.homeyId) : null;
  if (!listed || !cloudUrl || cloudUrl === listed.baseUrl) return;
  if (await cloudAnswers(cloudUrl, fetchImpl, ADDRESS_CHECK_TIMEOUT_MS)) {
    learnCloudUrl(storage, listed.homeyId, cloudUrl);
  }
};

// The installed app starts here and goes straight to a Homey: the one a build
// or the PELS settings page names (`open`), else the one opened last. It stays
// on the list when the owner came to choose, or a build sent them back for a
// new key. A link never fills in the add form: where an API key is sent must
// come from the owner, or a crafted link could collect keys.
const start = async () => {
  // A code's keys leave the address bar before anything else happens.
  const pairing = readPairing(window.location.hash);
  if (pairing.state !== 'none') {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }
  pointToApiKeys();
  await learnLinkedCloudAddress();
  if (pairing.state !== 'none') {
    // `render` shows the add form at once when nothing is listed; the offer
    // then takes its place.
    const rendering = render();
    offerPairedHomeys(pairing);
    await rendering;
    return;
  }
  const stored = loadStoredHomeys(storage);
  const byHomeyId = (homeyId: string | null) => (
    stored.homeys.find((homey) => homey.homeyId === homeyId) ?? null
  );
  const reauth = byHomeyId(params.get('reauth'));
  // A named Homey that is not listed yet must not fall back to the last one:
  // the owner came to add it.
  const target = params.has('open') ? byHomeyId(params.get('open')) : byHomeyId(stored.lastHomeyId);
  if (!reauth && !params.has('choose') && target) {
    emptyHint.hidden = true;
    const check = await checkAndRender(target);
    if (check.status.state === 'open') {
      openHomey(check.homey, check.status.version, check.address);
      return;
    }
  }
  await render();
  if (reauth) showAddPanel(reauth);
};

void start();
