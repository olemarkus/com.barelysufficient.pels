// How the standalone (outside Homey) web app reaches each Homey. The settings
// WebView gets a session injected by Homey; the web app instead carries one API
// key per Homey, created by the owner under Settings → API Keys with permission
// to control apps (`homey.app.control`). That scope is exactly what Homey checks
// on PELS's non-public routes and on app settings reads/writes.

export const PELS_APP_ID = 'com.barelysufficient.pels';

export type RemoteConnection = {
  // Origin the REST and socket calls go to: the Athom cloud relay
  // (`https://<homeyId>.connect.athom.com`) or the Homey's own LAN address.
  baseUrl: string;
  // Needed by the socket handshake; the relay does not forward `X-Homey-ID`.
  homeyId: string;
  // `<userId>:<sessionId>:<salt>`, sent as `Authorization: Bearer`.
  token: string;
};

export type StoredHomey = RemoteConnection & {
  // The owner's own label, shown when switching between Homeys.
  name: string;
};

const HOMEY_ID_PATTERN = /^[a-f0-9]{24}$/i;
const CLOUD_HOST_SUFFIX = '.connect.athom.com';

type HomeyAddress = {
  baseUrl: string;
  // Known from the address alone for a cloud id or relay URL; a LAN address
  // has to be asked (`X-Homey-ID` on the ping response).
  homeyId: string | null;
};

const cloudAddress = (homeyId: string): HomeyAddress => {
  const id = homeyId.toLowerCase();
  return { baseUrl: `https://${id}${CLOUD_HOST_SUFFIX}`, homeyId: id };
};

// Accepts what an owner can copy: the bare Homey id, the address bar of the
// Homey web app (`https://my.homey.app/homeys/<id>/...`), a relay URL, or a
// LAN URL such as `https://192-168-1-50.homey.homeylocal.com`.
export const parseHomeyAddress = (input: string): HomeyAddress | null => {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (HOMEY_ID_PATTERN.test(trimmed)) return cloudAddress(trimmed);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const webAppHomeyId = /^\/homeys\/([a-f0-9]{24})(\/|$)/i.exec(url.pathname)?.[1];
  if (url.hostname === 'my.homey.app') return webAppHomeyId ? cloudAddress(webAppHomeyId) : null;
  const baseUrl = url.origin;
  if (url.hostname.endsWith(CLOUD_HOST_SUFFIX)) {
    const label = url.hostname.slice(0, -CLOUD_HOST_SUFFIX.length);
    return { baseUrl, homeyId: HOMEY_ID_PATTERN.test(label) ? label.toLowerCase() : null };
  }
  return { baseUrl, homeyId: null };
};

const API_KEY_PATTERN = /^[^:\s]+:[^:\s]+:[^:\s]+$/;

export const isHomeyApiKey = (value: string): boolean => API_KEY_PATTERN.test(value.trim());

// One storage record shared by the launcher and every per-version build: they
// are served from the same origin, so they read the same localStorage. Builds
// of older PELS versions keep reading this shape for as long as they are
// published, so it only ever grows by optional fields; a breaking change needs
// a new key.
const STORAGE_KEY = 'pels.webapp.homeys.v1';

type StoredHomeys = {
  homeys: StoredHomey[];
  lastHomeyId: string | null;
};

const EMPTY: StoredHomeys = { homeys: [], lastHomeyId: null };

const isStoredHomey = (value: unknown): value is StoredHomey => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredHomey>;
  return typeof candidate.baseUrl === 'string'
    && typeof candidate.homeyId === 'string'
    && HOMEY_ID_PATTERN.test(candidate.homeyId)
    && typeof candidate.token === 'string'
    && isHomeyApiKey(candidate.token)
    && typeof candidate.name === 'string';
};

// Storage can be unavailable (private window, blocked site data); the web app
// then starts with no Homeys rather than failing to load. A malformed entry is
// dropped on its own so one bad record does not lose the others.
export const loadStoredHomeys = (storage: Storage | null): StoredHomeys => {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<StoredHomeys> | null;
    const homeys = Array.isArray(parsed?.homeys) ? parsed.homeys.filter(isStoredHomey) : [];
    const lastHomeyId = typeof parsed?.lastHomeyId === 'string'
      && homeys.some((homey) => homey.homeyId === parsed.lastHomeyId)
      ? parsed.lastHomeyId
      : null;
    return { homeys, lastHomeyId };
  } catch {
    return EMPTY;
  }
};

// False when the browser refused the write (blocked site data, full quota), so
// the caller can say so instead of showing a list that silently lost a Homey.
const write = (storage: Storage | null, value: StoredHomeys): boolean => {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

export const findStoredHomey = (storage: Storage | null, homeyId: string): StoredHomey | null => (
  loadStoredHomeys(storage).homeys.find((homey) => homey.homeyId === homeyId) ?? null
);

// Adding a Homey that is already listed replaces it: that is how a new key
// for the same Homey is stored.
export const saveStoredHomey = (storage: Storage | null, homey: StoredHomey): boolean => {
  const current = loadStoredHomeys(storage);
  const others = current.homeys.filter((entry) => entry.homeyId !== homey.homeyId);
  return write(storage, { ...current, homeys: [...others, homey] });
};

export const removeStoredHomey = (storage: Storage | null, homeyId: string): void => {
  const current = loadStoredHomeys(storage);
  // A refused write leaves the Homey listed, which the list then shows.
  write(storage, {
    homeys: current.homeys.filter((entry) => entry.homeyId !== homeyId),
    lastHomeyId: current.lastHomeyId === homeyId ? null : current.lastHomeyId,
  });
};

// Only a convenience for the next start; a refused write just means the
// launcher shows the list instead of opening this Homey.
export const markLastHomey = (storage: Storage | null, homeyId: string): void => {
  write(storage, { ...loadStoredHomeys(storage), lastHomeyId: homeyId });
};

export const readBrowserStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

// A LAN address does not name its Homey; Homey answers a ping with its id.
export const resolveLanHomeyId = async (baseUrl: string): Promise<string | null> => {
  try {
    const response = await window.fetch(`${baseUrl}/api/manager/system/ping`);
    const homeyId = response.headers.get('X-Homey-ID');
    return homeyId && HOMEY_ID_PATTERN.test(homeyId) ? homeyId.toLowerCase() : null;
  } catch {
    return null;
  }
};

// Which Homey a build page shows. The settings UI navigates with query-string
// routes that drop the `#homey=` fragment the launcher opens it with, so a tab
// keeps its Homey in session storage across those navigations and reloads; a
// link opened in a new tab falls back to the Homey opened last.
export const pickBuildHomeyId = (
  fragmentHomeyId: string | null,
  tabHomeyId: string | null,
  stored: StoredHomeys,
): string | null => {
  const listed = (homeyId: string | null) => (
    homeyId && stored.homeys.some((homey) => homey.homeyId === homeyId) ? homeyId : null
  );
  return listed(fragmentHomeyId) ?? listed(tabHomeyId) ?? stored.lastHomeyId;
};
