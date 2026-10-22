import { SETTINGS_PATH, type RemoteRequest } from './remoteHomeyClient.ts';
import type { RealtimeStatus } from './remoteRealtime.ts';

// Homey only delivers `settings.set` / `settings.unset` while the socket is
// up, and the settings UI caches settings until one of those events arrives.
// So the copy of PELS's settings taken while live is compared with a fresh read
// after every reconnect, and each difference is announced as the event Homey
// would have sent. Runtime read models (plan, power, devices, prices) catch up
// on their own refresh timers or with the next event.

type SettingsSnapshot = Map<string, string>;

const readSnapshot = async (request: RemoteRequest): Promise<SettingsSnapshot | null> => {
  const settings = await request('GET', SETTINGS_PATH).catch(() => null);
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null;
  return new Map(Object.entries(settings).map(([key, value]) => [key, JSON.stringify(value)]));
};

export const createSettingsResync = (
  request: RemoteRequest,
  dispatch: (event: string, data: unknown) => void,
) => {
  let known: SettingsSnapshot | null = null;
  // Keys Homey announced while live: the copy no longer vouches for them.
  let announced = new Set<string>();
  let live = false;

  const catchUp = async () => {
    const current = await readSnapshot(request);
    if (!current) return;
    const previous = known;
    const touched = announced;
    known = current;
    announced = new Set();
    if (!previous) return;
    for (const key of new Set([...previous.keys(), ...current.keys(), ...touched])) {
      if (!touched.has(key) && previous.get(key) === current.get(key)) continue;
      dispatch(current.has(key) ? 'settings.set' : 'settings.unset', key);
    }
  };

  return {
    // The first live status only takes the copy. A change in the moment between
    // the page's first reads and that first subscription is not caught here.
    onStatus: (status: RealtimeStatus): void => {
      if (status !== 'live') {
        live = false;
        return;
      }
      if (live) return;
      live = true;
      void catchUp();
    },
    // A key announced while live is announced again after the next reconnect,
    // whatever it holds by then, so a value changed live and changed back or
    // removed while offline is not missed.
    onSettingsEvent: (key: string): void => {
      announced.add(key);
    },
  };
};
