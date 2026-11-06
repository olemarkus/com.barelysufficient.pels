import Homey from 'homey';
import { io } from 'socket.io-client';
import { createDeviceLiveFeed, type DeviceLiveFeed } from '../../lib/device/liveFeed';
import { getLogger } from '../../lib/logging/logger';
import { createLiveFeedSocketHarness } from '../helpers/liveFeedSocketHarness';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

const settle = async (): Promise<void> => {
  // Drain the finite handshake/subscribe promise chain; never advance timeout clocks.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('device live feed subscriptions', () => {
  let sockets: ReturnType<typeof createLiveFeedSocketHarness>;
  let feed: DeviceLiveFeed;
  const onCapabilityUpdate = vi.fn();
  const onDeviceUpdate = vi.fn();
  const onDeviceInventoryChanged = vi.fn<() => Promise<void>>();

  beforeEach(async () => {
    vi.useFakeTimers();
    onDeviceInventoryChanged.mockReset().mockResolvedValue(undefined);
    sockets = createLiveFeedSocketHarness();
    vi.mocked(io).mockReturnValue(sockets.root);
    feed = createDeviceLiveFeed({
      homey: new Homey.App(),
      logger: { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('live-feed-test') },
      callbacks: { onDeviceUpdate, onCapabilityUpdate, onDeviceInventoryChanged },
    });
    await feed.start();
  });

  afterEach(async () => {
    await feed.stop();
    onDeviceUpdate.mockClear();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('passes a device added after boot through the update path', async () => {
    // Periodic refreshes re-read only known ids, so a car app installed later is
    // seen first by its creation frame.
    await settle();
    const car = { id: 'car-2', name: 'Polestar', class: 'car', capabilities: [], capabilitiesObj: {} };

    sockets.namespace.deliver('homey:manager:devices', 'device.create', car);
    sockets.namespace.deliver('homey:manager:devices', 'device.delete', car);

    expect(onDeviceUpdate).toHaveBeenCalledTimes(1);
    expect(onDeviceUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'car-2' }));
  });

  it('coalesces create/delete bursts into one inventory read, without refreshing for updates', async () => {
    await settle();
    sockets.namespace.deliver('homey:manager:devices', 'device.update', { id: 'heater' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDeviceInventoryChanged).not.toHaveBeenCalled();
    sockets.namespace.deliver('homey:manager:devices', 'device.create', { id: 'heater' });
    await vi.advanceTimersByTimeAsync(300);
    // Deletion needs no capability payload: REST supplies the new inventory.
    sockets.namespace.deliver('homey:manager:devices', 'device.delete', { id: 'old-heater' });
    await vi.advanceTimersByTimeAsync(499);
    expect(onDeviceInventoryChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDeviceInventoryChanged).toHaveBeenCalledTimes(1);
  });

  it('reads again for an event during an in-flight read, without overlapping reads', async () => {
    let finishRead!: () => void;
    onDeviceInventoryChanged.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRead = resolve; }));
    await settle();
    sockets.namespace.deliver('homey:manager:devices', 'device.create', { id: 'heater' });
    await vi.advanceTimersByTimeAsync(500);
    sockets.namespace.deliver('homey:manager:devices', 'device.delete', { id: 'heater' });
    await vi.advanceTimersByTimeAsync(500);
    expect(onDeviceInventoryChanged).toHaveBeenCalledTimes(1);
    finishRead();
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(onDeviceInventoryChanged).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending inventory read on stop', async () => {
    await settle();
    sockets.namespace.deliver('homey:manager:devices', 'device.delete', { id: 'heater' });
    await feed.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDeviceInventoryChanged).not.toHaveBeenCalled();
  });

  it('accepts later inventory events after a failed read', async () => {
    onDeviceInventoryChanged.mockRejectedValueOnce(new Error('offline'));
    await settle();
    sockets.namespace.deliver('homey:manager:devices', 'device.delete', { id: 'heater' });
    await vi.advanceTimersByTimeAsync(500);
    sockets.namespace.deliver('homey:manager:devices', 'device.create', { id: 'heater' });
    await vi.advanceTimersByTimeAsync(500);
    expect(onDeviceInventoryChanged).toHaveBeenCalledTimes(2);
  });

  it('subscribes once when tracked-device updates overlap before acknowledgement', async () => {
    feed.updateTrackedDevices(['heater']);
    feed.updateTrackedDevices(['heater']);
    sockets.namespace.acknowledge('heater');
    await settle();
    sockets.namespace.capability('heater');
    expect(onCapabilityUpdate).toHaveBeenCalledTimes(1);
    expect(sockets.namespace.subscriptions).toEqual(['homey:device:heater']);
  });

  it('does not attach a listener for a device removed while its subscription is pending', async () => {
    feed.updateTrackedDevices(['heater']);
    feed.updateTrackedDevices([]);
    sockets.namespace.acknowledge('heater');
    await settle();
    sockets.namespace.capability('heater');
    expect(onCapabilityUpdate).not.toHaveBeenCalled();
    expect(sockets.namespace.unsubscriptions).toContain('homey:device:heater');
  });

  it('does not continue an outdated pass into devices that are no longer tracked', async () => {
    feed.updateTrackedDevices(['heater', 'charger']);
    feed.updateTrackedDevices(['heater']);
    sockets.namespace.acknowledge('heater');
    await settle();
    expect(sockets.namespace.subscriptions).toEqual(['homey:device:heater']);
  });

  it('ignores an old acknowledgement when reconnect reuses the namespace socket', async () => {
    feed.updateTrackedDevices(['heater']);
    const acknowledgeOld = sockets.namespace.takeAcknowledgement('heater');
    sockets.reconnect();
    await settle();
    acknowledgeOld();
    sockets.namespace.acknowledge('heater');
    await settle();
    sockets.namespace.capability('heater');
    expect(onCapabilityUpdate).toHaveBeenCalledTimes(1);
  });

  it('retries a refused subscription on the next update without duplicating listeners', async () => {
    feed.updateTrackedDevices(['heater']);
    sockets.namespace.acknowledge('heater', new Error('temporarily unavailable'));
    await settle();
    feed.updateTrackedDevices(['heater']);
    sockets.namespace.acknowledge('heater');
    await settle();
    sockets.namespace.capability('heater');
    expect(onCapabilityUpdate).toHaveBeenCalledTimes(1);
    expect(sockets.namespace.subscriptions).toHaveLength(2);
  });

  it('keeps the replacement subscription when a removed device returns before the old acknowledgement', async () => {
    feed.updateTrackedDevices(['heater']);
    const acknowledgeOld = sockets.namespace.takeAcknowledgement('heater');
    feed.updateTrackedDevices([]);
    feed.updateTrackedDevices(['heater']);
    acknowledgeOld();
    await settle();
    sockets.namespace.acknowledge('heater');
    await settle();
    sockets.namespace.capability('heater');
    expect(onCapabilityUpdate).toHaveBeenCalledTimes(1);
    expect(sockets.namespace.subscriptions).toHaveLength(2);
  });

  it('retries after an acknowledgement timeout and ignores the late response', async () => {
    feed.updateTrackedDevices(['heater']);
    const acknowledgeLate = sockets.namespace.takeAcknowledgement('heater');
    await vi.advanceTimersByTimeAsync(15001);
    feed.updateTrackedDevices(['heater']);
    acknowledgeLate();
    sockets.namespace.acknowledge('heater');
    await settle();
    sockets.namespace.capability('heater');
    expect(onCapabilityUpdate).toHaveBeenCalledTimes(1);
    expect(sockets.namespace.subscriptions).toHaveLength(2);
  });

  it('ignores a subscription acknowledgement after stop', async () => {
    feed.updateTrackedDevices(['heater']);
    await feed.stop();
    sockets.namespace.acknowledge('heater');
    await settle();
    // A stopped socket hears nothing, so a frame proves nothing here. Socket.IO
    // reuses this namespace socket on the next start, so a listener a late ack
    // attached now would fire then.
    expect(sockets.namespace.events.listenerCount('homey:device:heater')).toBe(0);
  });
});
