// SDK-boundary e2e for the onoff pull-gap case.
//
// The test keeps PELS internals real. The Homey API pull path is stubbed with a
// device whose onoff capability is advertised but whose value is missing, the
// realtime push enters through the real socket live-feed adapter, and the final
// assertion is the SDK write PELS emits under capacity pressure after trusted
// realtime evidence survives the next pull snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeSocketListener = (...args: unknown[]) => void;

const socketHarness = vi.hoisted(() => {
  class FakeSocket {
    connected = false;
    readonly io: { on: () => void; socket: (namespace: string) => FakeSocket };
    private readonly listeners = new Map<string, Set<FakeSocketListener>>();

    constructor(private readonly onNamespaceSocket: (socket: FakeSocket) => void = () => {}) {
      this.io = {
        on: () => {},
        socket: () => {
          const socket = new FakeSocket();
          this.onNamespaceSocket(socket);
          return socket;
        },
      };
    }

    on(event: string, listener: FakeSocketListener): this {
      let listeners = this.listeners.get(event);
      if (!listeners) {
        listeners = new Set();
        this.listeners.set(event, listeners);
      }
      listeners.add(listener);
      return this;
    }

    once(event: string, listener: FakeSocketListener): this {
      const onceListener: FakeSocketListener = (...args) => {
        this.off(event, onceListener);
        listener(...args);
      };
      return this.on(event, onceListener);
    }

    off(event: string, listener?: FakeSocketListener): this {
      if (!listener) {
        this.listeners.delete(event);
        return this;
      }
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }

    connect(): this {
      this.connected = true;
      queueMicrotask(() => this.emitFromServer('connect'));
      return this;
    }

    open(): this {
      return this.connect();
    }

    disconnect(): this {
      this.connected = false;
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      if (event === 'handshakeClient') {
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          queueMicrotask(() => callback(null, { namespace: '/api' }));
        }
        return true;
      }
      if (event === 'subscribe') {
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          queueMicrotask(() => callback(null));
        }
        return true;
      }
      return this.emitFromServer(event, ...args);
    }

    emitFromServer(event: string, ...args: unknown[]): boolean {
      const listeners = this.listeners.get(event);
      if (!listeners) return false;
      for (const listener of Array.from(listeners)) listener(...args);
      return true;
    }
  }

  let namespacedSocket: FakeSocket | null = null;
  const createRootSocket = () => new FakeSocket((socket) => {
    namespacedSocket = socket;
  });
  const io = vi.fn(createRootSocket);
  return {
    io,
    reset: () => {
      namespacedSocket = null;
      io.mockImplementation(createRootSocket);
      io.mockClear();
    },
    emitCapability: (deviceId: string, capabilityId: string, value: unknown) => {
      if (!namespacedSocket) {
        throw new Error('Live-feed namespace socket is not connected');
      }
      const delivered = namespacedSocket.emitFromServer(
        `homey:device:${deviceId}`,
        'capability',
        { capabilityId, value },
      );
      if (!delivered) {
        throw new Error(`No live-feed listener subscribed for device ${deviceId}`);
      }
    },
  };
});

vi.mock('socket.io-client', () => ({
  io: socketHarness.io,
}));

import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { drainUntil, drainUntilCalledWith } from '../utils/asyncDrain';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';

const DEVICE_ID = 'device-a';
const FRESH_ISO = '2026-06-03T06:00:00.000Z';

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

const onoffCap = (deviceId: string) => `manager/devices/device/${deviceId}/capability/onoff`;
const deviceListPullPath = 'manager/devices/device';

const buildPullDeviceWithMissingOnoff = () => ({
  id: DEVICE_ID,
  name: 'On/Off Socket',
  class: 'socket',
  capabilities: ['onoff', 'measure_power'],
  capabilitiesObj: {
    onoff: { id: 'onoff' },
    measure_power: { id: 'measure_power', value: 2000, lastUpdated: FRESH_ISO },
  },
  settings: {},
  available: true,
  ready: true,
});

const configureCapacity = (limitKw: number) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, limitKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('managed_devices', { [DEVICE_ID]: true });
  mockHomeyInstance.settings.set('controllable_devices', { [DEVICE_ID]: true });
};

const stubSdk = (params: { totalW: () => number }) => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  const getSpy = vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: params.totalW() } }] };
    }
    if (path === deviceListPullPath) {
      return { [DEVICE_ID]: buildPullDeviceWithMissingOnoff() };
    }
    if (path === `manager/devices/device/${DEVICE_ID}`) {
      return buildPullDeviceWithMissingOnoff();
    }
    return originalGet(path);
  });
  return getSpy;
};

const countDeviceListPulls = (getSpy: ReturnType<typeof stubSdk>) => (
  getSpy.mock.calls.filter(([path]) => path === deviceListPullPath).length
);

const waitForDeviceListPullAfter = async (
  getSpy: ReturnType<typeof stubSdk>,
  previousCount: number,
) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushPromises();
    if (countDeviceListPulls(getSpy) > previousCount) return;
  }
  throw new Error('Expected settings-triggered device list refresh');
};

describe('On/off realtime observation across pull gap (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: new Date(FRESH_ISO),
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    socketHarness.reset();
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not control a cold-start missing onoff value before realtime arrives', async () => {
    let totalW = 500;
    const device = new MockDevice(DEVICE_ID, 'On/Off Socket', ['onoff', 'measure_power'], 'socket');
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    configureCapacity(1);
    stubSdk({ totalW: () => totalW });

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await flushPromises();
    putSpy.mockClear();

    totalW = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    // Negative assertion: drive the detached poll→plan→execute chain to
    // quiescence before asserting absence. A fixed flush could assert before a
    // late write lands, so a "missing onoff is wrongly controllable" regression
    // could slip past. Drain bounded rounds waiting for any write: a buggy off
    // write lands within them (and fails the assert); the correct no-write case
    // exhausts the rounds and drainUntil throws — swallowed so we reach the
    // assertion with the cycle fully settled.
    await drainUntil(() => putSpy.mock.calls.length > 0, { rounds: 20 }).catch(() => {});

    expect(putSpy).not.toHaveBeenCalledWith(onoffCap(DEVICE_ID), { value: false });
  });

  it('preserves realtime onoff=true when the next pull still omits the onoff value', async () => {
    let totalW = 500;
    const device = new MockDevice(DEVICE_ID, 'On/Off Socket', ['onoff', 'measure_power'], 'socket');
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });
    configureCapacity(1);
    const getSpy = stubSdk({ totalW: () => totalW });

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');

    const app = createApp();
    await app.onInit();
    await flushPromises();

    socketHarness.emitCapability(DEVICE_ID, 'onoff', true);
    await flushPromises();

    const pullsBeforeRefresh = countDeviceListPulls(getSpy);
    mockHomeyInstance.settings.set('refresh_target_devices_snapshot', Date.now());
    await waitForDeviceListPullAfter(getSpy, pullsBeforeRefresh);
    putSpy.mockClear();

    totalW = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    // Wait for the detached poll→plan→execute chain to reach the SDK write
    // instead of a fixed flush, which flakes to zero calls under full-suite CPU
    // load (notes/testing-taxonomy.md). The toHaveBeenCalledWith below then gives
    // a readable diff and is guaranteed to hold once this resolves.
    await drainUntilCalledWith(putSpy, onoffCap(DEVICE_ID), { value: false });

    expect(putSpy).toHaveBeenCalledWith(onoffCap(DEVICE_ID), { value: false });
  });
});
