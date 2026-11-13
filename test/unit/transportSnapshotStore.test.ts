import { TransportSnapshotStore } from '../../lib/device/transport/transportSnapshotStore';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const device = (id: string, name: string): HomeyDeviceLike => ({ ...HOMEY_DEVICE_FIELDS, id, name });

describe('accepted raw-device lookup', () => {
  it('keeps tracked observations ahead of full reads and exposes the full read after untracking', () => {
    const store = new TransportSnapshotStore();
    const initial = device('one', 'Initial');
    const tracked = device('one', 'Tracked');
    const refreshed = device('one', 'Refreshed');
    store.replaceLatestRawDevices([initial], [initial]);
    store.trackRawDevice('one', tracked);
    const lookup = store.getLastAcceptedRawDevice;
    store.replaceLatestRawDevices([refreshed], [refreshed]);
    expect(lookup('one')).toBe(tracked);
    expect(store.getLastAcceptedRawDevicesById().get('one')).toBe(tracked);
    store.untrackRawDevice('one');
    expect(lookup('one')).toBe(refreshed);
  });

  it('replaces membership and drops the prior full read when an inventory generation changes', () => {
    const store = new TransportSnapshotStore();
    const first = device('one', 'One');
    const second = device('two', 'Two');
    store.replaceLatestRawDevices([first], [first]);
    store.replaceLatestRawDevices([second], [second]);
    expect(store.getLastAcceptedRawDevice('one')).toBeUndefined();
    expect(store.getDeviceMembership('one')).toBe('removed');
    expect(store.getLastAcceptedRawDevice('two')).toBe(second);
  });

  it('publishes independent capability updates through both indexed and inventory reads', () => {
    const store = new TransportSnapshotStore();
    const original = device('one', 'Original');
    const updated = device('one', 'Updated');
    store.replaceLatestRawDevices([original], [original]);
    store.trackRawDevice('one', original);
    store.updateAcceptedRawDevice(updated);
    expect(store.getLastAcceptedRawDevice('one')).toBe(updated);
    expect(store.getTrackedRawDevice('one')).toBe(updated);
    expect(store.getLatestRawDevices()).toEqual([updated]);
  });

  it('resolves duplicate view identities consistently using the last accepted entry', () => {
    const store = new TransportSnapshotStore();
    const first = device('one', 'First');
    const last = device('one', 'Last');
    const updated = device('one', 'Updated');
    store.replaceLatestRawDevices([first, last], [first, last]);
    expect(store.getLastAcceptedRawDevice('one')).toBe(last);
    expect(store.getLastAcceptedRawDevicesById().get('one')).toBe(last);
    store.updateAcceptedRawDevice(updated);
    expect(store.getLastAcceptedRawDevice('one')).toBe(updated);
    expect(store.getLastAcceptedRawDevicesById().get('one')).toBe(updated);
    expect(store.getLatestRawDevices()).toEqual([first, updated]);
  });
});
