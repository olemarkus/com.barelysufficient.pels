import Homey from 'homey';
import { getLogger } from '../../lib/logging/logger';
import { DEVICES_API_PATH, ENERGY_LIVE_API_PATH, setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { createTestDeviceTransport, initWithLiveFeed } from '../helpers/deviceTransportHarness';
import { emitDeviceInventoryChange } from '../helpers/liveFeedSocketHarness';
import { homeyDevice } from '../helpers/homeyDevicePayload';
import { mockHomeyInstance } from '../mocks/homey';

const heater = (id: string) => homeyDevice({ id, name: id, class: 'heater' }, {
  onoff: true, measure_power: 1000,
}, new Date().toISOString());

describe('device inventory events', () => {
  it('discovers newly paired unmanaged devices and removes deleted devices from the picker', async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const transport = createTestDeviceTransport(new Homey.App(), {
      log: vi.fn(), error: vi.fn(), structuredLog: getLogger('inventory-test'),
    }, { settings: { isManaged: () => false } }, undefined, { onDeviceInventoryRefreshed: notify });
    try {
      await initWithLiveFeed(transport);
      let inventory: Record<string, ReturnType<typeof heater>> = { first: heater('first') };
      const get = vi.fn(async (path: string) => path === DEVICES_API_PATH
        ? inventory : mockHomeyInstance.api.get(path));
      setRestClient({ get, put: vi.fn() });
      await transport.refreshSnapshot({ includeLivePower: false, meterDeviceIds: [] });
      expect(transport.getUiPickerDevices().map((device) => device.id)).toEqual(['first']);
      inventory = { ...inventory, second: heater('second') };
      emitDeviceInventoryChange('device.create', 'second');
      await vi.advanceTimersByTimeAsync(500);
      expect(transport.getUiPickerDevices().map((device) => device.id)).toEqual(['first', 'second']);
      expect(notify).toHaveBeenCalledTimes(1);
      inventory = { first: heater('first') };
      emitDeviceInventoryChange('device.delete', 'second');
      await vi.advanceTimersByTimeAsync(500);
      expect(transport.getUiPickerDevices().map((device) => device.id)).toEqual(['first']);
      expect(notify).toHaveBeenCalledTimes(2);
      expect(get.mock.calls.filter(([path]) => path === DEVICES_API_PATH)).toHaveLength(3);
    } finally {
      transport.destroy();
      vi.useRealTimers();
    }
  });
  it('waits for an older targeted read before refreshing a deleted device out of inventory', async () => {
    vi.useFakeTimers();
    const transport = createTestDeviceTransport(new Homey.App(), {
      log: vi.fn(), error: vi.fn(), structuredLog: getLogger('inventory-test'),
    });
    try {
      await initWithLiveFeed(transport);
      const first = heater('first');
      const removed = heater('removed');
      let inventory: Record<string, ReturnType<typeof heater>> = { first, removed };
      let finishOldRead!: (device: ReturnType<typeof heater>) => void;
      const oldRead = new Promise<ReturnType<typeof heater>>((resolve) => { finishOldRead = resolve; });
      const get = vi.fn(async (path: string) => {
        if (path === DEVICES_API_PATH) return inventory;
        if (path === `${DEVICES_API_PATH}/first`) return first;
        if (path === `${DEVICES_API_PATH}/removed`) return oldRead;
        return mockHomeyInstance.api.get(path);
      });
      setRestClient({ get, put: vi.fn() });
      await transport.refreshSnapshot({ includeLivePower: false, meterDeviceIds: [] });
      const targeted = transport.refreshSnapshot({ includeLivePower: false, targetedRefresh: true, meterDeviceIds: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledWith(`${DEVICES_API_PATH}/removed`);
      inventory = { first };
      emitDeviceInventoryChange('device.delete', 'removed');
      await vi.advanceTimersByTimeAsync(500);
      expect(get.mock.calls.filter(([path]) => path === DEVICES_API_PATH)).toHaveLength(1);
      finishOldRead(removed);
      await targeted;
      await vi.advanceTimersByTimeAsync(0);
      expect(get.mock.calls.filter(([path]) => path === DEVICES_API_PATH)).toHaveLength(2);
      expect(transport.getSnapshot().map((device) => device.id)).toEqual(['first']);
    } finally {
      transport.destroy();
      vi.useRealTimers();
    }
  });

  it.each(['empty', 'failed'] as const)('retries a deferred %s inventory read on the next scheduled refresh', async (failure) => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const transport = createTestDeviceTransport(new Homey.App(), {
      log: vi.fn(), error: vi.fn(), structuredLog: getLogger('inventory-test'),
    }, {}, undefined, { onDeviceInventoryRefreshed: notify });
    try {
      await initWithLiveFeed(transport);
      let degraded = false;
      let inventory: Record<string, ReturnType<typeof heater>> = { first: heater('first') };
      const get = vi.fn(async (path: string) => {
        if (path === DEVICES_API_PATH) {
          if (degraded && failure === 'failed') throw new Error('offline');
          return degraded ? {} : inventory;
        }
        return mockHomeyInstance.api.get(path);
      });
      setRestClient({ get, put: vi.fn() });
      await transport.refreshSnapshot({ includeLivePower: false, meterDeviceIds: [] });
      degraded = true;
      emitDeviceInventoryChange('device.create', 'second');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(notify).not.toHaveBeenCalled();
      degraded = false;
      inventory = { ...inventory, second: heater('second') };
      await transport.refreshSnapshot({ includeLivePower: false, targetedRefresh: true, meterDeviceIds: [] });
      expect(transport.getSnapshot().map((device) => device.id)).toEqual(['first', 'second']);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      transport.destroy();
      vi.useRealTimers();
    }
  });

  it('does not commit or notify when stopped while an inventory read is pending', async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const transport = createTestDeviceTransport(new Homey.App(), {
      log: vi.fn(), error: vi.fn(), structuredLog: getLogger('inventory-test'),
    }, {}, undefined, { onDeviceInventoryRefreshed: notify });
    try {
      await initWithLiveFeed(transport);
      let finish!: (value: object) => void;
      const read = new Promise<object>((resolve) => { finish = resolve; });
      setRestClient({ get: async () => read, put: vi.fn() });
      emitDeviceInventoryChange('device.create', 'first');
      await vi.advanceTimersByTimeAsync(500);
      transport.destroy();
      finish({ first: heater('first') });
      await vi.advanceTimersByTimeAsync(0);
      expect(transport.getSnapshot()).toEqual([]);
      expect(transport.getUiPickerDevices()).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      transport.destroy();
      vi.useRealTimers();
    }
  });

  it('preserves live-report power and its timestamp when the inventory read skips live power', async () => {
    vi.useFakeTimers();
    const transport = createTestDeviceTransport(new Homey.App(), {
      log: vi.fn(), error: vi.fn(), structuredLog: getLogger('inventory-test'),
    });
    try {
      await initWithLiveFeed(transport);
      const first = homeyDevice({ id: 'first', name: 'First', class: 'socket' }, { onoff: true }, new Date().toISOString());
      setRestClient({
        get: async (path) => {
          if (path === DEVICES_API_PATH) return { first };
          if (path === ENERGY_LIVE_API_PATH) return { items: [{ type: 'device', id: 'first', values: { W: 125 } }] };
          return mockHomeyInstance.api.get(path);
        },
        put: vi.fn(),
      });
      await transport.refreshSnapshot({ meterDeviceIds: [] });
      const accepted = transport.getSnapshotByDeviceId('first')?.measuredPowerReading;
      expect(accepted).toMatchObject({ powerKw: 0.125 });
      emitDeviceInventoryChange('device.delete', 'other');
      await vi.advanceTimersByTimeAsync(500);
      expect(transport.getSnapshotByDeviceId('first')).toMatchObject({
        measuredPowerReading: accepted, measuredPowerKw: 0.125, measuredPowerSource: 'homey_energy',
      });
    } finally {
      transport.destroy();
      vi.useRealTimers();
    }
  });

});
