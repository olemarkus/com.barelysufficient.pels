// The addresses a Homey is reached on, and which of them the web app accepts.
// An API key goes to whatever address it is given, so every address that is
// pasted, linked or stored must be one that leads to the owner's own Homey:
// an Athom cloud host named for that Homey, or the Homey's secure address on
// the home network. The PELS settings page uses this too, without the web
// app's storage.

import { cloudHostHomeyId } from '../../../shared-domain/src/homeyCloudHost.ts';

export const HOMEY_ID_PATTERN = /^[a-f0-9]{24}$/i;
// Athom's relay for any Homey. It limits each Homey to a few dozen calls in a
// burst, so it is only the address of last resort. The Homey's own cloud host
// has no such limit; its rule is shared with PELS, which learns it
// (`shared-domain/src/homeyCloudHost.ts`).
const RELAY_HOST = /^([a-f0-9]{24})\.connect\.athom\.com$/i;
// Homey's certificate on the home network names this host, which resolves to
// the dashed IP. HTTPS is on 443 for a Homey Pro and 4860 for a Self-Hosted
// Server.
const LOCAL_HOST = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.homey\.homeylocal\.com$/i;
const LOCAL_HTTPS_PORTS = new Set(['', '4860']);
// A Homey reports the port it serves HTTP on; HTTPS is on the paired port.
const HTTPS_PORT_FOR_HTTP_PORT = new Map([['', ''], ['80', ''], ['4859', ':4860']]);
const PRIVATE_IPV4 = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const isPrivateIpv4 = (octets: readonly string[]): boolean => (
  octets.length === 4
  && octets.every((octet) => Number(octet) <= 255)
  && PRIVATE_IPV4.some((range) => range.test(octets.join('.')))
);

// The Homey a cloud address leads to, from its host name; null for any other
// address. Both hosts are Athom's, so the id in the name is the Homey reached.
const cloudHomeyId = (url: URL): string | null => {
  if (url.protocol !== 'https:' || url.port !== '') return null;
  return RELAY_HOST.exec(url.hostname)?.[1]?.toLowerCase() ?? cloudHostHomeyId(url.hostname);
};

export const relayUrl = (homeyId: string): string => `https://${homeyId.toLowerCase()}.connect.athom.com`;

// `origin` as this Homey's cloud address, or null when it is anything else.
export const cloudAddressFor = (origin: string, homeyId: string): string | null => {
  const url = parseUrl(origin);
  return url && cloudHomeyId(url) === homeyId.toLowerCase() ? url.origin : null;
};

// `value` as a Homey's secure home-network address, or null when it is
// anything else.
export const localAddressFrom = (value: string): string | null => {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:' || !LOCAL_HTTPS_PORTS.has(url.port)) return null;
  const octets = LOCAL_HOST.exec(url.hostname)?.slice(1, 5);
  return octets && isPrivateIpv4(octets) ? url.origin : null;
};

// Homey's secure home-network address, as the Athom account lists it, from
// the plain `ip:port` Homey reports for itself (verified against the account's
// `localUrlSecure` for a Homey Pro and a Self-Hosted Server). The browser needs
// HTTPS, so any other port, a public address, or junk gives null and the web
// app stays on the cloud.
export const localUrlFromAddress = (address: unknown): string | null => {
  if (typeof address !== 'string') return null;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d+))?$/.exec(address.trim());
  const httpsPort = HTTPS_PORT_FOR_HTTP_PORT.get(match?.[5] ?? '');
  const octets = match?.slice(1, 5);
  if (!octets || httpsPort === undefined || !isPrivateIpv4(octets)) return null;
  return `https://${octets.join('-')}.homey.homeylocal.com${httpsPort}`;
};

export type HomeyAddress =
  | { kind: 'cloud'; baseUrl: string; homeyId: string }
  // A home-network address does not name its Homey; Homey's ping answers it.
  | { kind: 'local'; baseUrl: string };

// Accepts what an owner can copy: the bare Homey id, the address bar of the
// Homey web app (`https://my.homey.app/homeys/<id>/...`), the address the PELS
// settings page shows, a relay URL, or the home-network address such as
// `https://192-168-1-50.homey.homeylocal.com`.
export const parseHomeyAddress = (input: string): HomeyAddress | null => {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (HOMEY_ID_PATTERN.test(trimmed)) {
    return { kind: 'cloud', baseUrl: relayUrl(trimmed), homeyId: trimmed.toLowerCase() };
  }
  const url = parseUrl(trimmed);
  if (!url) return null;
  if (url.protocol === 'https:' && url.hostname === 'my.homey.app') {
    const webAppHomeyId = /^\/homeys\/([a-f0-9]{24})(\/|$)/i.exec(url.pathname)?.[1];
    return webAppHomeyId
      ? { kind: 'cloud', baseUrl: relayUrl(webAppHomeyId), homeyId: webAppHomeyId.toLowerCase() }
      : null;
  }
  const homeyId = cloudHomeyId(url);
  if (homeyId) return { kind: 'cloud', baseUrl: url.origin, homeyId };
  const local = localAddressFrom(trimmed);
  return local ? { kind: 'local', baseUrl: local } : null;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ping = async (baseUrl: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Response | null> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return await fetchImpl(`${baseUrl}/api/manager/system/ping`, { signal: abort.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// The Homey answering on a home-network address, from the id Homey puts on its
// ping. The timeout bounds the wait for an address that leads nowhere, such as
// the home-network address while the phone is away from home.
export const pingHomeyId = async (baseUrl: string, fetchImpl: FetchLike, timeoutMs: number): Promise<string | null> => {
  const homeyId = (await ping(baseUrl, fetchImpl, timeoutMs))?.headers.get('X-Homey-ID');
  return homeyId && HOMEY_ID_PATTERN.test(homeyId) ? homeyId.toLowerCase() : null;
};

// Whether a cloud address answers at all. The cloud does not let a browser read
// the ping's id, but it routes by the id in the host name.
export const cloudAnswers = async (baseUrl: string, fetchImpl: FetchLike, timeoutMs: number): Promise<boolean> => (
  (await ping(baseUrl, fetchImpl, timeoutMs))?.ok === true
);
