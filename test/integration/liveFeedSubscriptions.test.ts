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

  beforeEach(async () => {
    vi.useFakeTimers();
    sockets = createLiveFeedSocketHarness();
    vi.mocked(io).mockReturnValue(sockets.root);
    feed = createDeviceLiveFeed({
      homey: new Homey.App(),
      logger: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), structuredLog: getLogger('live-feed-test') },
      callbacks: { onDeviceUpdate: vi.fn(), onCapabilityUpdate },
    });
    await feed.start();
  });

  afterEach(async () => {
    await feed.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
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
    sockets.namespace.capability('heater');
    expect(onCapabilityUpdate).not.toHaveBeenCalled();
  });
});
