// Unit coverage for the transport's realtime zone-move notification
// (`lib/device/transport/transportNotifications.ts`): the membership recompute
// that holds a device in an unknown zone out of every home must run before,
// and regardless of, the transport's own zone-tree refetch.
import { describe, expect, it } from 'vitest';
import { TransportNotifications } from '../../lib/device/transport/transportNotifications';

const noSnapshotListener = (): void => undefined;

describe('TransportNotifications.notifyDeviceZoneChanged', () => {
  it('recomputes membership before refetching the zone tree', () => {
    const calls: string[] = [];
    const notifications = new TransportNotifications(noSnapshotListener, (zoneId) => calls.push(`refetch:${zoneId}`));
    notifications.setDeviceZoneChanged(() => calls.push('recompute'));

    notifications.notifyDeviceZoneChanged('z-new');

    expect(calls).toEqual(['recompute', 'refetch:z-new']);
  });

  it('still recomputes membership when the refetch throws', () => {
    const calls: string[] = [];
    const notifications = new TransportNotifications(noSnapshotListener, () => {
      throw new Error('zone tree refetch failed');
    });
    notifications.setDeviceZoneChanged(() => calls.push('recompute'));

    expect(() => notifications.notifyDeviceZoneChanged('z-new')).toThrow('zone tree refetch failed');
    expect(calls).toEqual(['recompute']);
  });

  it('recomputes without a refetch when the device reports no zone', () => {
    const calls: string[] = [];
    const notifications = new TransportNotifications(noSnapshotListener, (zoneId) => calls.push(`refetch:${zoneId}`));
    notifications.setDeviceZoneChanged(() => calls.push('recompute'));

    notifications.notifyDeviceZoneChanged(null);

    expect(calls).toEqual(['recompute']);
  });
});
