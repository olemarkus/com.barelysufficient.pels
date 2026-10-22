// How the standalone (outside Homey) web app reaches each Homey. The settings
// WebView gets a session injected by Homey; the web app instead carries one API
// key per Homey, created by the owner under Settings → API Keys with permission
// to control apps (`homey.app.control`). That scope is exactly what Homey checks
// on PELS's non-public routes and on app settings reads/writes.

import { HOMEY_ID_PATTERN, cloudAddressFor, localAddressFrom, relayUrl } from './homeyAddress.ts';

export const PELS_APP_ID = 'com.barelysufficient.pels';

export type RemoteConnection = {
  // Origin the REST and socket calls go to: the Homey's cloud address or its
  // address on the home network, whichever this page chose.
  baseUrl: string;
  // Needed by the socket handshake; the relay does not forward `X-Homey-ID`.
  homeyId: string;
  // `<userId>:<sessionId>:<salt>`, sent as `Authorization: Bearer`.
  token: string;
};

export type StoredHomey = RemoteConnection & {
  // The owner's own label, shown when switching between Homeys.
  name: string;
  // The Homey's address on the home network, when known: calls go there
  // whenever this Homey answers on it, and `baseUrl`, its cloud address,
  // serves everywhere else.
  localUrl: string | null;
};

const API_KEY_PATTERN = /^[^:\s]+:[^:\s]+:[^:\s]+$/;

export const isHomeyApiKey = (value: string): boolean => API_KEY_PATTERN.test(value.trim());

// One storage record shared by the launcher and every per-version build: they
// are served from the same origin, so they read the same localStorage. Builds
// of older PELS versions keep reading this shape for as long as they are
// published, so it only ever grows by optional fields; a breaking change needs
// a new key. `baseUrl` therefore stays the address every build can use.
const STORAGE_KEY = 'pels.webapp.homeys.v1';

type StoredHomeys = {
  homeys: StoredHomey[];
  lastHomeyId: string | null;
};

const EMPTY: StoredHomeys = { homeys: [], lastHomeyId: null };

// The record as stored. Records written before the web app knew a Homey's
// home-network address have no `localUrl` and may carry that address in
// `baseUrl`; loading moves it over.
type StoredRecord = RemoteConnection & { name: string; localUrl?: string | null };

const isStoredRecord = (value: unknown): value is StoredRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof StoredRecord, unknown>>;
  return typeof candidate.baseUrl === 'string'
    && typeof candidate.homeyId === 'string'
    && HOMEY_ID_PATTERN.test(candidate.homeyId)
    && typeof candidate.token === 'string'
    && isHomeyApiKey(candidate.token)
    && typeof candidate.name === 'string'
    && (candidate.localUrl === undefined || candidate.localUrl === null || typeof candidate.localUrl === 'string');
};

// Only addresses that lead to this Homey are kept; any other address in the
// record is dropped, so a key is never sent to it.
const fromRecord = (record: StoredRecord): StoredHomey => {
  const cloud = cloudAddressFor(record.baseUrl, record.homeyId);
  const stored = typeof record.localUrl === 'string' ? localAddressFrom(record.localUrl) : null;
  return {
    name: record.name,
    homeyId: record.homeyId,
    token: record.token,
    baseUrl: cloud ?? relayUrl(record.homeyId),
    localUrl: stored ?? (cloud ? null : localAddressFrom(record.baseUrl)),
  };
};

// Storage can be unavailable (private window, blocked site data); the web app
// then starts with no Homeys rather than failing to load. A malformed entry is
// dropped on its own so one bad record does not lose the others.
export const loadStoredHomeys = (storage: Storage | null): StoredHomeys => {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<StoredHomeys> | null;
    const homeys = Array.isArray(parsed?.homeys) ? parsed.homeys.filter(isStoredRecord).map(fromRecord) : [];
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

// Adding a Homey that is already listed replaces it in place: that is how a
// new key or a newly learned address for the same Homey is stored.
export const saveStoredHomey = (storage: Storage | null, homey: StoredHomey): boolean => {
  const current = loadStoredHomeys(storage);
  const listed = current.homeys.some((entry) => entry.homeyId === homey.homeyId);
  const homeys = listed
    ? current.homeys.map((entry) => (entry.homeyId === homey.homeyId ? homey : entry))
    : [...current.homeys, homey];
  return write(storage, { ...current, homeys });
};

// A better address for a listed Homey, kept for the next start. The record is
// read again first, so a key saved meanwhile (another tab, a slow check) is
// not overwritten. A Homey that reported no address keeps the one it gave
// before. When the browser refuses the write, the stored record is what
// stands, so that is what is returned.
const learnAddress = (
  storage: Storage | null,
  homeyId: string,
  change: (homey: StoredHomey) => StoredHomey,
): StoredHomey | null => {
  const listed = findStoredHomey(storage, homeyId);
  if (!listed) return null;
  const updated = change(listed);
  if (updated.baseUrl === listed.baseUrl && updated.localUrl === listed.localUrl) return listed;
  return saveStoredHomey(storage, updated) ? updated : listed;
};

// Its own cloud host, from the PELS settings page's link.
export const learnCloudUrl = (storage: Storage | null, homeyId: string, cloudUrl: string): StoredHomey | null => (
  learnAddress(storage, homeyId, (homey) => ({ ...homey, baseUrl: cloudUrl }))
);

// The home-network address the Homey reported.
export const learnLocalUrl = (
  storage: Storage | null,
  homeyId: string,
  localUrl: string | null,
): StoredHomey | null => learnAddress(storage, homeyId, (homey) => (
  { ...homey, localUrl: localUrl ?? homey.localUrl }
));

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
