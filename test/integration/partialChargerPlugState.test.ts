import type Homey from 'homey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import { buildEvCarLinkChargerViews } from '../../lib/device/evCarLinkWiring';
import { getLogger } from '../../lib/logging/logger';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { resolveCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { createTestDeviceTransport, initWithLiveFeed, seedTransportDevices } from '../helpers/deviceTransportHarness';
import { emitDeviceUpdate } from '../helpers/liveFeedSocketHarness';
import { homeyDevice, setable } from '../helpers/homeyDevicePayload';
import { mockHomeyInstance } from '../mocks/homey';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';

const BASE = Date.parse('2026-10-01T12:00:00Z');
const stamp = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const ID = 'canonical-charger';
let transport: DeviceTransport;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
  transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, {
    log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test/partial-charger-state'),
  });
  await initWithLiveFeed(transport);
});

afterEach(() => {
  transport.destroy();
  vi.useRealTimers();
  setRestClient({
    get: path => mockHomeyInstance.api.get(path),
    put: (path, body) => mockHomeyInstance.api.put(path, body),
  });
});

const charger = (at: string) => homeyDevice({
  id: ID, name: 'Canonical charger', class: 'evcharger', available: true,
}, {
  onoff: setable(true), evcharger_charging: setable(true),
  evcharger_charging_state: 'plugged_in_paused', measure_power: 7000,
}, at);

const carViews = () => buildEvCarLinkChargerViews(transport.getSnapshot(), () => [], {
  hasCarStopEvidence: () => false,
});

const sdkWrites = () => {
  const put = vi.fn().mockResolvedValue(undefined);
  setRestClient({ get: path => mockHomeyInstance.api.get(path), put });
  return put;
};

describe('cold charger fields resolve independently', () => {
  it.each(['null', 'invalid enum', 'missing entry', 'undated'] as const)(
    'keeps power and safe OFF control while plug state is %s, then accepts a real state', async kind => {
      const initial = charger(stamp(0));
      const state = initial.capabilitiesObj.evcharger_charging_state;
      const { evcharger_charging_state: _unreadableState, ...siblings } = initial.capabilitiesObj;
      const unreadable = kind === 'missing entry' ? siblings : {
        ...siblings,
        evcharger_charging_state: kind === 'undated'
          ? { ...state, lastUpdated: null }
          : { ...state, value: kind === 'null' ? null : 'invalid' },
      };
      await seedTransportDevices(transport, [{ ...initial, capabilitiesObj: unreadable }]);
      const snapshot = transport.getSnapshotByDeviceId(ID);
      if (!snapshot) throw new Error('Expected independent charger observations');
      expect(snapshot).toMatchObject({ id: ID, available: true, measuredPowerKw: 7, binaryControl: { on: true } });
      expect(snapshot.evChargingState).toBeUndefined();
      expect(isEvObserved(snapshot)).toBe(false);
      expect(resolveCommandableNow(snapshot)).toBe(false);
      expect(transport.canTurnOnDevice(ID)).toBe(false);
      expect(carViews()).toEqual([]);
      expect(transport.getHomeyDeviceIds().has(ID)).toBe(true);

      const put = sdkWrites();
      await expect(transport.setCapability(ID, 'evcharger_charging', true)).rejects.toThrow('not ready');
      expect(put).not.toHaveBeenCalled();
      await transport.setCapability(ID, 'evcharger_charging', false);
      expect(put).toHaveBeenCalledWith(
        `manager/devices/device/${ID}/capability/evcharger_charging`, pelsCapabilityWrite(false),
      );

      vi.setSystemTime(BASE + 120_000);
      emitDeviceUpdate(charger(stamp(2)));
      expect(transport.getSnapshotByDeviceId(ID)).toMatchObject({
        evChargingState: 'plugged_in_paused', available: true, measuredPowerKw: 7,
      });
      expect(carViews()).toHaveLength(1);
      expect(transport.canTurnOnDevice(ID)).toBe(true);
      await transport.setCapability(ID, 'evcharger_charging', true);
    },
  );

  it.each(['null', 'wrong type', 'missing entry', 'undated'] as const)(
    'keeps plug state and power when charging control is %s without adopting onoff', async kind => {
      const initial = charger(stamp(0));
      const charging = initial.capabilitiesObj.evcharger_charging;
      const { evcharger_charging: _unreadableControl, ...siblings } = initial.capabilitiesObj;
      const unreadable = kind === 'missing entry' ? siblings : {
        ...siblings,
        evcharger_charging: kind === 'undated'
          ? { ...charging, lastUpdated: null }
          : { ...charging, value: kind === 'null' ? null : 'invalid' },
      };
      await seedTransportDevices(transport, [{ ...initial, capabilitiesObj: unreadable }]);
      const snapshot = transport.getSnapshotByDeviceId(ID);
      if (!snapshot) throw new Error('Expected independent plug and power observations');
      expect(snapshot).toMatchObject({ id: ID, evChargingState: 'plugged_in_paused', measuredPowerKw: 7 });
      expect(snapshot.binaryCapabilityId).toBe('evcharger_charging');
      expect(snapshot.binaryControlObservation).toBeUndefined();
      expect(snapshot.evCharging).toBeUndefined();
      expect(snapshot.capabilities).not.toContain('onoff');
      expect(transport.canTurnOnDevice(ID)).toBe(false);
      const put = sdkWrites();
      await expect(transport.setCapability(ID, 'evcharger_charging', true)).rejects.toThrow('not ready');
      expect(put).not.toHaveBeenCalled();
      await transport.setCapability(ID, 'evcharger_charging', false);
      expect(put).toHaveBeenCalledWith(
        `manager/devices/device/${ID}/capability/evcharger_charging`, pelsCapabilityWrite(false),
      );
    },
  );

});
