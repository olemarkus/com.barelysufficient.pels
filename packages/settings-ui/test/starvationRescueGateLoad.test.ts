// The rescue chip's gate (`state.starvationRescuableDeviceIds`) is loaded by
// overlapping fetches: two `plan_updated` pushes while Overview is visible, or a
// push racing an Overview open. Only the latest load may commit, so a response
// that lands out of order can never overwrite a newer set.
const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
  invalidateApiCache: vi.fn(),
}));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));

const { loadStarvationRescuableDevices, createStarvationRescue } = await import('../src/ui/starvationRescue.ts');
const { state } = await import('../src/ui/state.ts');

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  callApi.mockReset();
  state.starvationRescuableDeviceIds = new Set();
});

describe('loadStarvationRescuableDevices', () => {
  it('keeps the newer set when an older overlapping load resolves last', async () => {
    const older = deferred<{ rescuableDeviceIds: string[] }>();
    const newer = deferred<{ rescuableDeviceIds: string[] }>();
    callApi.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const olderLoad = loadStarvationRescuableDevices();
    const newerLoad = loadStarvationRescuableDevices();

    newer.resolve({ rescuableDeviceIds: ['heater-2'] });
    await newerLoad;
    expect([...state.starvationRescuableDeviceIds]).toEqual(['heater-2']);

    older.resolve({ rescuableDeviceIds: ['heater-1'] });
    await olderLoad;
    expect([...state.starvationRescuableDeviceIds]).toEqual(['heater-2']);
  });

  it('does not re-add a just-rescued device from a load that went out before the create', async () => {
    state.starvationRescuableDeviceIds = new Set(['heater-1', 'heater-2']);
    const staleLoad = deferred<{ rescuableDeviceIds: string[] }>();
    callApi
      .mockReturnValueOnce(staleLoad.promise)
      .mockResolvedValueOnce({ ok: true, runsCurrentHour: true });

    const load = loadStarvationRescuableDevices();
    await createStarvationRescue('heater-1');
    expect(state.starvationRescuableDeviceIds.has('heater-1')).toBe(false);

    staleLoad.resolve({ rescuableDeviceIds: ['heater-1', 'heater-2'] });
    await load;
    expect(state.starvationRescuableDeviceIds.has('heater-1')).toBe(false);
  });
});
