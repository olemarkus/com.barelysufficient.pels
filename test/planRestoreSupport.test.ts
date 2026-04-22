import { reserveHeadroomForPendingRestores } from '../lib/plan/planRestoreSupport';
import { PENDING_RESTORE_WINDOW_MS } from '../lib/plan/planConstants';
import { buildPlanDevice } from './utils/planTestUtils';

describe('reserveHeadroomForPendingRestores', () => {
  it('does not rewrite missing device names to ids in restore_headroom_reserved logs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T10:00:00.000Z'));

    const debugStructured = vi.fn();
    const now = Date.now();

    const adjusted = reserveHeadroomForPendingRestores({
      rawHeadroom: 5,
      planDevices: [buildPlanDevice({
        id: 'dev-1',
        name: 'Heater',
        currentOn: true,
        powerKw: 2,
        measuredPowerKw: 0,
      })],
      lastDeviceRestoreMs: { 'dev-1': now - (PENDING_RESTORE_WINDOW_MS / 2) },
      measurementTs: null,
      debugStructured,
      deviceNameById: new Map(),
    });

    expect(adjusted).toBeCloseTo(3, 6);
    expect(debugStructured).toHaveBeenCalledWith({
      event: 'restore_headroom_reserved',
      pendingKw: 2,
      deviceIds: ['dev-1'],
      devices: [{ deviceId: 'dev-1' }],
      headroomAfterKw: 3,
    });

    vi.useRealTimers();
  });
});
