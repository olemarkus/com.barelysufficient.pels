import { parseHomeyAddress, relayUrl } from './homeyAddress.ts';
import { MAX_HOMEY_NAME_LENGTH, isHomeyApiKey, type StoredHomey } from './remoteConnection.ts';

// Moving the web app's Homeys to a phone. API keys are made in the Homey web
// app, which is hard to use at phone width, so the owner adds Homeys on a
// computer and the launcher there shows a code for the phone's camera. The
// code is a link to the launcher with the Homeys after `#pair=`: a fragment
// never reaches the web server, and the phone's launcher removes it from the
// address bar before asking the owner to add them.

const PAIR_PARAM = 'pair';

// Per Homey: its name, its key, and its cloud address, or just its id when
// that is the relay. The phone learns the home-network address on first open.
type PairedHomey = [name: string, token: string, address: string];

const toBase64Url = (text: string): string => {
  const binary = String.fromCharCode(...new TextEncoder().encode(text));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): string => {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

export const pairingLink = (launcherUrl: string, homeys: readonly StoredHomey[]): string => {
  const paired: PairedHomey[] = homeys.map((homey) => [
    homey.name,
    homey.token,
    homey.baseUrl === relayUrl(homey.homeyId) ? homey.homeyId : homey.baseUrl,
  ]);
  return `${launcherUrl}#${PAIR_PARAM}=${toBase64Url(JSON.stringify(paired))}`;
};

const toStoredHomey = (entry: unknown): StoredHomey | null => {
  if (!Array.isArray(entry) || entry.length !== 3) return null;
  const [name, token, address] = entry as unknown[];
  if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_HOMEY_NAME_LENGTH) return null;
  if (typeof token !== 'string' || !isHomeyApiKey(token) || typeof address !== 'string') return null;
  // Only an Athom cloud address for the Homey it names, as when pasted.
  const parsed = parseHomeyAddress(address);
  if (parsed?.kind !== 'cloud') return null;
  return { name: name.trim(), homeyId: parsed.homeyId, token: token.trim(), baseUrl: parsed.baseUrl, localUrl: null };
};

export type PairingRead =
  | { state: 'none' }
  | { state: 'homeys'; homeys: StoredHomey[] }
  // The fragment held a code that is cut off or was not made by the web app.
  | { state: 'unreadable' };

export const readPairing = (hash: string): PairingRead => {
  const encoded = new URLSearchParams(hash.replace(/^#/, '')).get(PAIR_PARAM);
  if (encoded === null) return { state: 'none' };
  try {
    const entries: unknown = JSON.parse(fromBase64Url(encoded));
    if (!Array.isArray(entries)) return { state: 'unreadable' };
    const homeys = entries.map(toStoredHomey).filter((homey): homey is StoredHomey => homey !== null);
    // Each Homey once: a code naming one twice was not made by the web app.
    const distinct = new Set(homeys.map((homey) => homey.homeyId)).size === homeys.length;
    return homeys.length > 0 && homeys.length === entries.length && distinct
      ? { state: 'homeys', homeys }
      : { state: 'unreadable' };
  } catch {
    return { state: 'unreadable' };
  }
};
