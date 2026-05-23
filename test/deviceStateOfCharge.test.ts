import { resolveStateOfChargeSnapshot } from '../lib/device/stateOfCharge';

describe('resolveStateOfChargeSnapshot', () => {
  it('prefers native SoC capabilities over flow-backed battery reports', () => {
    const snapshot = resolveStateOfChargeSnapshot({
      deviceClassKey: 'evcharger',
      nowMs: Date.parse('2026-03-20T06:00:02.000Z'),
      capabilityObj: {
        evcharger_charging_state: {
          id: 'evcharger_charging_state',
          value: 'plugged_in_charging',
          lastUpdated: '2026-03-20T06:00:00.000Z',
        },
        measure_soc_level: {
          id: 'measure_soc_level',
          value: 55,
          lastUpdated: '2026-03-20T06:00:01.000Z',
        },
      },
      reportedCapabilities: {
        measure_battery: {
          value: 42,
          reportedAt: Date.parse('2026-03-20T05:58:00.000Z'),
          source: 'flow',
        },
      },
    });

    expect(snapshot).toEqual(expect.objectContaining({
      percent: 55,
      capabilityId: 'measure_soc_level',
      status: 'fresh',
    }));
  });
});
