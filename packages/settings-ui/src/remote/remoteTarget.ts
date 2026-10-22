import { pingHomeyId } from './homeyAddress.ts';
import type { RemoteConnection, StoredHomey } from './remoteConnection.ts';

// Where one page's calls to a Homey go. At home the Homey answers on the home
// network, which is quicker than the cloud and counts against no cloud limit;
// away from home that address leads nowhere, so the cloud address serves.

export type AddressChoice = 'local' | 'cloud';

// Long enough for a Homey on the home network, short enough that a phone away
// from home is not kept waiting long before the cloud takes over.
const LOCAL_PROBE_TIMEOUT_MS = 1500;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// The home-network address is used only when the Homey answering there is
// this one: the address may since belong to another device.
export const chooseAddress = async (homey: StoredHomey, fetchImpl: FetchLike): Promise<AddressChoice> => {
  if (homey.localUrl === null) return 'cloud';
  const answering = await pingHomeyId(homey.localUrl, fetchImpl, LOCAL_PROBE_TIMEOUT_MS);
  return answering === homey.homeyId ? 'local' : 'cloud';
};

// The launcher hands the address it just checked to the build it opens, so
// opening a Homey probes once. It is kept for this tab only and taken once: a
// link cannot set it, and a reload probes again, as the phone may have left
// home. The build takes it only while its stored record still holds that very
// address.
const CHOICE_KEY = 'pels.webapp.addressChoice';

export const handOverAddress = (homeyId: string, baseUrl: string): void => {
  try {
    window.sessionStorage.setItem(CHOICE_KEY, JSON.stringify({ homeyId, baseUrl }));
  } catch {
    // The build probes on its own.
  }
};

export const takeHandedAddress = (homey: StoredHomey): AddressChoice | null => {
  try {
    const raw = window.sessionStorage.getItem(CHOICE_KEY);
    window.sessionStorage.removeItem(CHOICE_KEY);
    const handed = raw ? JSON.parse(raw) as { homeyId?: unknown; baseUrl?: unknown } : null;
    if (handed?.homeyId !== homey.homeyId) return null;
    if (homey.localUrl !== null && handed.baseUrl === homey.localUrl) return 'local';
    return handed.baseUrl === homey.baseUrl ? 'cloud' : null;
  } catch {
    return null;
  }
};

export type RemoteTarget = {
  connection: () => RemoteConnection;
  // Which address calls go to now.
  address: () => AddressChoice;
  // A call to `attempted` could not reach the Homey. When that was the
  // home-network address, as when a phone leaves home with the page open, the
  // page moves to the cloud for good and this answers true, also for calls
  // that were already under way when another call moved it.
  leftHomeNetwork: (attempted: string) => boolean;
  // Called once the page moved, so the realtime socket can follow.
  onMove: (listener: () => void) => void;
};

export const createRemoteTarget = (homey: StoredHomey, choice: AddressChoice): RemoteTarget => {
  const local = choice === 'local' ? homey.localUrl : null;
  let baseUrl = local ?? homey.baseUrl;
  const listeners: (() => void)[] = [];
  return {
    connection: () => ({ baseUrl, homeyId: homey.homeyId, token: homey.token }),
    address: () => (baseUrl === homey.baseUrl ? 'cloud' : 'local'),
    leftHomeNetwork: (attempted) => {
      if (local === null || attempted !== local) return false;
      if (baseUrl === local) {
        baseUrl = homey.baseUrl;
        listeners.forEach((listener) => listener());
      }
      return true;
    },
    onMove: (listener) => {
      listeners.push(listener);
    },
  };
};
