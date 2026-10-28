import { createSettingsResync } from '../src/remote/remoteSettingsResync.ts';
import type { RemoteRequest } from '../src/remote/remoteHomeyClient.ts';
import { SETTINGS_UI_BOOTSTRAP_PATH } from '../../contracts/src/settingsUiApi.ts';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_UPDATED_EVENT } from '../../shared-domain/src/settings/settingsKeys.ts';

// Homey only sends settings events while the socket is up; after a drop the
// web app compares settings and announces what it missed.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const setup = (bootstrapped: Promise<unknown> = Promise.resolve(null)) => {
  let settings: Record<string, unknown> = {};
  // No bootstrap answer unless a test publishes active plans.
  let activePlans: unknown;
  const request = vi.fn(async (_method: string, path: string) => {
    if (!path.endsWith(SETTINGS_UI_BOOTSTRAP_PATH)) return settings;
    return activePlans === undefined ? null : { deferredObjectiveActivePlans: activePlans };
  }) as unknown as RemoteRequest;
  const dispatch = vi.fn();
  const resync = createSettingsResync(request, dispatch, bootstrapped);
  const store = (next: Record<string, unknown>) => {
    settings = next;
  };
  const planActive = (next: unknown) => {
    activePlans = next;
  };
  return { resync, dispatch, store, request, planActive };
};

const reconnect = async (resync: ReturnType<typeof createSettingsResync>) => {
  resync.onStatus('offline');
  resync.onStatus('connecting');
  resync.onStatus('live');
  await flush();
};

describe('settings resync after a dropped socket', () => {
  it('reconciles prefetched settings only after boot is ready', async () => {
    let finishBoot!: (bootstrap: unknown) => void;
    const bootstrapped = new Promise((resolve) => { finishBoot = resolve; });
    const { resync, dispatch, store, request } = setup(bootstrapped);
    store({ mode: 'Away', kept: 1, added: true, other: 'baseline' });
    resync.onStatus('live');
    resync.onStatus('offline');
    resync.onStatus('live');
    await flush();
    expect(request).not.toHaveBeenCalled();

    finishBoot({ settings: { mode: 'Home', kept: 1, removed: true, absent: null, added: null } });
    await flush();

    expect(dispatch.mock.calls).toEqual([
      ['settings.set', 'mode'],
      ['settings.unset', 'removed'],
      ['settings.set', 'added'],
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    store({ mode: 'Away', kept: 1, added: true, other: 'changed' });
    await reconnect(resync);
    expect(dispatch).toHaveBeenLastCalledWith('settings.set', 'other');
  });

  it('discards a snapshot from a superseded connection', async () => {
    let finishOldRead!: (settings: unknown) => void;
    const oldRead = new Promise((resolve) => { finishOldRead = resolve; });
    const { resync, dispatch, store, request } = setup(Promise.resolve({ settings: { mode: 'Home' } }));
    vi.mocked(request).mockReturnValueOnce(oldRead);
    resync.onStatus('live');
    await flush();

    store({ mode: 'Away' });
    await reconnect(resync);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('settings.set', 'mode');

    finishOldRead({ mode: 'Home' });
    await flush();
    await reconnect(resync);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('establishes a live baseline when the bootstrap failed', async () => {
    const { resync, dispatch, store } = setup(Promise.reject(new Error('bootstrap failed')));
    store({ mode: 'Away' });
    resync.onStatus('live');
    await flush();
    expect(dispatch).not.toHaveBeenCalled();

    store({ mode: 'Home' });
    await reconnect(resync);
    expect(dispatch).toHaveBeenCalledWith('settings.set', 'mode');
  });

  it('only takes a copy on the first live status', async () => {
    const { resync, dispatch, store, request } = setup();
    store({ a: 1 });
    resync.onStatus('live');
    resync.onStatus('live');
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('announces settings set, changed and removed while offline', async () => {
    const { resync, dispatch, store } = setup();
    store({ kept: 1, changed: { a: 1 }, removed: true });
    resync.onStatus('live');
    await flush();

    store({ kept: 1, changed: { a: 2 }, added: 'x' });
    await reconnect(resync);

    expect(dispatch.mock.calls).toEqual(expect.arrayContaining([
      ['settings.set', 'changed'],
      ['settings.set', 'added'],
      ['settings.unset', 'removed'],
    ]));
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('re-announces a key changed live, even if it is back to the copied value', async () => {
    const { resync, dispatch, store } = setup();
    store({ flag: true, other: 1 });
    resync.onStatus('live');
    await flush();

    // Changed while live (the UI saw `false`), then back to `true` while offline.
    resync.onSettingsEvent('flag');
    resync.onSettingsEvent('other');
    store({ flag: true });
    await reconnect(resync);

    expect(dispatch.mock.calls).toEqual(expect.arrayContaining([
      ['settings.set', 'flag'],
      ['settings.unset', 'other'],
    ]));
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('keeps quiet when the settings read fails', async () => {
    const { resync, dispatch, store, request } = setup();
    store({ a: 1 });
    resync.onStatus('live');
    await flush();
    vi.mocked(request).mockRejectedValueOnce(new Error('offline'));
    await reconnect(resync);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('replays the active plans from the bootstrap after a reconnect, not on the first connection', async () => {
    const { resync, dispatch, store, planActive } = setup(Promise.resolve({ settings: {} }));
    const plans = { version: 1, plansByDeviceId: {} };
    planActive(plans);
    store({});
    resync.onStatus('live');
    await flush();
    expect(dispatch).not.toHaveBeenCalledWith(DEFERRED_OBJECTIVE_ACTIVE_PLANS_UPDATED_EVENT, expect.anything());
    await reconnect(resync);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(DEFERRED_OBJECTIVE_ACTIVE_PLANS_UPDATED_EVENT, plans);
  });
});
