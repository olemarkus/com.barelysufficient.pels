import { MeterInventory } from '../../lib/device/transport/meterInventory';
import { fetchDevicesWithFallback } from '../../lib/device/transport/managerFetch';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { getLogger } from '../../lib/logging/logger';

const logger = { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/devices') };
async function list(entries: AsyncIterable<unknown>): Promise<unknown[]> {
  const rows = [];
  for await (const entry of entries) rows.push(entry);
  return rows;
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const raw = (id: string, capabilities: unknown[]) => ({ id, capabilities, privateSettings: { large: 'unused' } });

describe('meter discovery shares complete inventories', () => {
  const registry = { meter: raw('meter', ['meter_power']), relay: raw('relay', ['onoff', { invalid: true }]) };
  const projected = [
    { id: 'meter', capabilities: ['meter_power'], capabilitiesReadable: true },
    { id: 'relay', capabilities: ['onoff'], capabilitiesReadable: false },
  ];
  let inventory: MeterInventory;
  let get: ReturnType<typeof vi.fn<(path: string) => Promise<unknown>>>;
  beforeEach(() => {
    inventory = new MeterInventory(() => true);
    get = vi.fn(async () => registry);
    setRestClient({ get, put: vi.fn() });
  });

  it('serves early and later backfills from the live snapshot including rejected device rows', async () => {
    inventory.expectBootstrap();
    const first = inventory.read(list);
    await expect(inventory.withSnapshot((publish) => fetchDevicesWithFallback({ logger, publish })))
      .resolves.toMatchObject({ devices: [], rejectedPayloads: 2 });
    await expect(first).resolves.toEqual(projected);
    inventory.observeDevice('meter', ['meter_power']);
    await expect(inventory.read(list)).resolves.toEqual(projected);
    expect(get).toHaveBeenCalledTimes(1);
    inventory.observeDevice('meter', ['meter_power', 'measure_power']);
    await inventory.read(list);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('coalesces fallback reads and retries an invalidated response', async () => {
    inventory.expectBootstrap();
    const first = inventory.read(list);
    const second = inventory.read(list);
    inventory.finishBootstrap();
    const started = deferred<void>();
    const obsolete = deferred<unknown>();
    get.mockImplementationOnce(() => { started.resolve(); return obsolete.promise; });
    await started.promise;
    inventory.invalidate();
    obsolete.resolve({ old: raw('old', []) });
    expect(await Promise.all([first, second])).toEqual([projected, projected]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('revalidates old metadata while disconnected and retains it while subscribed', async () => {
    vi.useFakeTimers();
    try {
      let subscribed = true;
      inventory = new MeterInventory(() => subscribed);
      await inventory.read(list);
      await vi.advanceTimersByTimeAsync(86_400_000);
      await inventory.read(list);
      expect(get).toHaveBeenCalledTimes(1);
      subscribed = false;
      await inventory.read(list);
      expect(get).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('releases weather on snapshot failure and allows recovery from a failed standalone read', async () => {
    inventory.expectBootstrap();
    get.mockRejectedValueOnce(new Error('offline'));
    const early = inventory.read(list);
    await expect(inventory.withSnapshot(async () => { throw new Error('snapshot failed'); })).rejects.toThrow();
    await expect(early).rejects.toThrow('offline');
    await expect(inventory.read(list)).resolves.toEqual(projected);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('bounds a weather wait without starting another registry read against a stalled snapshot', async () => {
    vi.useFakeTimers();
    try {
      inventory.expectBootstrap();
      const early = expect(inventory.read(list)).rejects.toThrow('still pending');
      await vi.advanceTimersByTimeAsync(120_001);
      await early;
      expect(get).not.toHaveBeenCalled();
      inventory.stop();
      await expect(inventory.read(list)).rejects.toThrow('shutdown');
    } finally { vi.useRealTimers(); }
  });

  it('discards the prior keyed result when a later live snapshot has an array envelope', async () => {
    await inventory.read(list);
    get.mockResolvedValue([registry.meter]);
    await inventory.withSnapshot((publish) => fetchDevicesWithFallback({ logger, publish }));
    await expect(inventory.read(list)).resolves.toEqual([]);
    expect(get).toHaveBeenCalledTimes(3);
  });
});
