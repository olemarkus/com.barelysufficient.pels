import { createSettingsResync } from '../src/remote/remoteSettingsResync.ts';
import type { RemoteRequest } from '../src/remote/remoteHomeyClient.ts';

// Homey only sends settings events while the socket is up; after a drop the
// web app compares settings and announces what it missed.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const setup = () => {
  let settings: Record<string, unknown> = {};
  const request = vi.fn(async () => settings) as unknown as RemoteRequest;
  const dispatch = vi.fn();
  const resync = createSettingsResync(request, dispatch);
  const store = (next: Record<string, unknown>) => {
    settings = next;
  };
  return { resync, dispatch, store, request };
};

const reconnect = async (resync: ReturnType<typeof createSettingsResync>) => {
  resync.onStatus('offline');
  resync.onStatus('connecting');
  resync.onStatus('live');
  await flush();
};

describe('settings resync after a dropped socket', () => {
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
});
