import { SETTINGS_PATH, type RemoteRequest } from './remoteHomeyClient.ts';
import type { RealtimeStatus } from './remoteRealtime.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_UPDATED_EVENT } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { SETTINGS_UI_BOOTSTRAP_PATH } from '../../../contracts/src/settingsUiApi.ts';
import { PELS_APP_ID } from './remoteConnection.ts';

// Homey only delivers `settings.set` / `settings.unset` while the socket is
// up, and the settings UI caches settings until one of those events arrives.
// So the copy of PELS's settings taken while live is compared with a fresh read
// after every reconnect, and each difference is announced as the event Homey
// would have sent. Runtime read models (plan, power, devices, prices) catch up
// on their own refresh timers or with the next event. The smart-task active
// plans have neither: they arrive only as a push on each change, so a reconnect
// re-reads them from the bootstrap and replays that push.

type SettingsSnapshot = Map<string, string>;

const snapshot = (settings: Record<string, unknown>): SettingsSnapshot => (
  new Map(Object.entries(settings).map(([key, value]) => [key, JSON.stringify(value)]))
);

const readSnapshot = async (request: RemoteRequest): Promise<SettingsSnapshot | null> => {
  const settings = await request('GET', SETTINGS_PATH).catch(() => null);
  if (!isUnknownRecord(settings)) return null;
  return snapshot(settings);
};

export const createSettingsResync = (
  request: RemoteRequest,
  dispatch: (event: string, data: unknown) => void,
  bootstrapped: Promise<unknown>,
) => {
  const initial = bootstrapped.then((bootstrap) => (
    isUnknownRecord(bootstrap) && isUnknownRecord(bootstrap.settings)
      ? snapshot(bootstrap.settings)
      : new Map<string, string>()
  )).catch(() => new Map<string, string>());
  let known: SettingsSnapshot | null = null;
  // Keys Homey announced while live: the copy no longer vouches for them.
  let announced = new Set<string>();
  let live = false;
  let connectionGeneration = 0;

  const catchUp = async (generation: number) => {
    const seeded = await initial;
    if (generation !== connectionGeneration) return;
    const current = await readSnapshot(request);
    if (!current || generation !== connectionGeneration) return;
    const previous = known;
    const touched = announced;
    known = current;
    announced = new Set();
    // Bootstrap contains only the settings the UI loaded. Other keys in the
    // first full snapshot are baseline data, not newly added settings.
    const keys = previous
      ? new Set([...previous.keys(), ...current.keys(), ...touched])
      : new Set([...seeded.keys(), ...touched]);
    for (const key of keys) {
      // Bootstrap reads absent settings as null; the full snapshot omits them.
      const unchanged = previous
        ? previous.get(key) === current.get(key)
        : seeded.get(key) === (current.get(key) ?? 'null');
      if (!touched.has(key) && unchanged) continue;
      dispatch(current.has(key) ? 'settings.set' : 'settings.unset', key);
    }
    if (previous) await catchUpActivePlans(generation);
  };

  const catchUpActivePlans = async (generation: number) => {
    const bootstrap = await request('GET', `/api/app/${PELS_APP_ID}${SETTINGS_UI_BOOTSTRAP_PATH}`).catch(() => null);
    if (generation !== connectionGeneration || !isUnknownRecord(bootstrap)) return;
    // The UI validates the payload as it validates the push itself.
    dispatch(DEFERRED_OBJECTIVE_ACTIVE_PLANS_UPDATED_EVENT, bootstrap.deferredObjectiveActivePlans);
  };

  return {
    // The first live snapshot reconciles the bootstrap after boot completes;
    // later snapshots cover changes missed while the socket was disconnected.
    onStatus: (status: RealtimeStatus): void => {
      if (status !== 'live') {
        live = false;
        connectionGeneration += 1;
        return;
      }
      if (live) return;
      live = true;
      connectionGeneration += 1;
      void catchUp(connectionGeneration);
    },
    // A key announced while live is announced again after the next reconnect,
    // whatever it holds by then, so a value changed live and changed back or
    // removed while offline is not missed.
    onSettingsEvent: (key: string): void => {
      announced.add(key);
    },
  };
};
