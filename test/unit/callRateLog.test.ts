const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('../../lib/logging/logger', () => ({ getLogger: () => ({ info }) }));

import { createCallRateLog } from '../../lib/diagnostics/callRateLog';
import { countHomeyApiCall } from '../../lib/device/transport/homeyApiCallCount';
import { getPerfSnapshot, incPerfCounter } from '../../lib/utils/perfCounters';

const MINUTE = 60_000;

describe('countHomeyApiCall', () => {
  it('counts a call under its method and path, with ids collapsed', () => {
    countHomeyApiCall('GET', '/api/manager/devices/device/378bcd81-bc9c-4eb6-93e1-a97b7e84b743');
    countHomeyApiCall('PUT', '/api/manager/devices/device/378bcd81-bc9c-4eb6-93e1-a97b7e84b743/capability/onoff');
    countHomeyApiCall('GET', '/api/manager/zones/zone?x=1');
    const counts = getPerfSnapshot().counts;
    expect(counts['homey_api.GET manager/devices/device/:id']).toBeGreaterThanOrEqual(1);
    expect(counts['homey_api.PUT manager/devices/device/:id/capability/onoff']).toBeGreaterThanOrEqual(1);
    expect(counts['homey_api.GET manager/zones/zone']).toBeGreaterThanOrEqual(1);
  });
});

describe('createCallRateLog', () => {
  beforeEach(() => info.mockReset());

  it('logs the watched counters that ran more than once a minute in the window', () => {
    const log = createCallRateLog(0);
    for (let i = 0; i < 25; i += 1) incPerfCounter('device_refresh.temperature_recovery_total');
    for (let i = 0; i < 5; i += 1) incPerfCounter('device_refresh.device_poll_total');
    for (let i = 0; i < 40; i += 1) incPerfCounter('plan_rebuild_total');
    log.onInterval(10 * MINUTE);

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: 'frequent_calls',
      windowMinutes: 10,
      calls: [{ key: 'device_refresh.temperature_recovery_total', count: 25, perMinute: 2.5 }],
    });
  });

  it('logs nothing in a window where every watched counter stayed at or below once a minute', () => {
    const log = createCallRateLog(0);
    for (let i = 0; i < 10; i += 1) incPerfCounter('homey_api.GET manager/flow/flowcardtrigger');
    log.onInterval(10 * MINUTE);
    expect(info).not.toHaveBeenCalled();
  });

  it('measures each window from the previous one, not from start', () => {
    const log = createCallRateLog(0);
    for (let i = 0; i < 30; i += 1) incPerfCounter('homey_api.GET manager/energy/live');
    log.onInterval(10 * MINUTE);
    info.mockReset();
    log.onInterval(20 * MINUTE);
    expect(info).not.toHaveBeenCalled();
  });
});
