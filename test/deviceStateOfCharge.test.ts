import { resolveStateOfChargeSnapshot } from '../lib/core/deviceStateOfCharge';

describe('resolveStateOfChargeSnapshot', () => {
  it('does not attach a flow source label to native SoC capabilities', () => {
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
      flowBackedCapabilityIds: ['measure_battery'],
      reportedCapabilities: {
        measure_battery: {
          value: 42,
          reportedAt: Date.parse('2026-03-20T05:58:00.000Z'),
          source: 'flow',
          sourceLabel: 'Tesla Flow',
        },
      },
    });

    expect(snapshot).toEqual(expect.objectContaining({
      percent: 55,
      source: 'capability',
      capabilityId: 'measure_soc_level',
      status: 'fresh',
    }));
    expect(snapshot?.sourceLabel).toBeUndefined();
  });
});
