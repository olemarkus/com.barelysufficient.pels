import {
  parseFlowReportedCapabilities,
  readFlowReportedCapabilitiesForDevice,
} from '../../lib/device/transport/flowReportedCapabilities';

describe('parseFlowReportedCapabilities', () => {
  const validEntry = {
    value: true,
    reportedAt: 1_700_000_000_000,
    source: 'flow',
  };

  it('returns an empty normalized map for non-record input', () => {
    expect(parseFlowReportedCapabilities(undefined)).toEqual({});
    expect(parseFlowReportedCapabilities(null)).toEqual({});
    expect(parseFlowReportedCapabilities('nope')).toEqual({});
    expect(parseFlowReportedCapabilities([{ onoff: validEntry }])).toEqual({});
  });

  it('keeps valid entries and drops devices whose entries all fail to parse', () => {
    const parsed = parseFlowReportedCapabilities({
      'device-a': { onoff: validEntry },
      'device-b': { onoff: { value: true, reportedAt: 0, source: 'flow' } },
    });

    expect(parsed).toEqual({
      'device-a': { onoff: validEntry },
    });
    // device-b dropped: its only entry had a non-positive reportedAt.
    expect(parsed['device-b']).toBeUndefined();
  });

  it('drops malformed device containers and malformed capability entries', () => {
    const parsed = parseFlowReportedCapabilities({
      'device-a': 'not-a-record',
      'device-b': {
        onoff: validEntry,
        // unknown/unsupported capability id is ignored
        bogus_capability: { value: true, reportedAt: 1, source: 'flow' },
        // wrong source is rejected
        evcharger_charging: { value: true, reportedAt: 1, source: 'native' },
        // wrong value type is rejected (boolean caps require boolean)
        'alarm_generic.car_connected': { value: 1, reportedAt: 1, source: 'flow' },
      },
    });

    expect(parsed).toEqual({
      'device-b': { onoff: validEntry },
    });
  });

  it('keeps the capability axis sparse — only reported capabilities are present', () => {
    const parsed = parseFlowReportedCapabilities({
      'device-a': { measure_battery: { value: 42, reportedAt: 5, source: 'flow' } },
    });

    expect(Object.keys(parsed['device-a'])).toEqual(['measure_battery']);
    // Normalization must NOT fabricate "fresh" entries for unreported capabilities.
    expect(parsed['device-a']?.onoff).toBeUndefined();
  });

  it('validates measure_battery bounds', () => {
    const parsed = parseFlowReportedCapabilities({
      ok: { measure_battery: { value: 0, reportedAt: 5, source: 'flow' } },
      tooHigh: { measure_battery: { value: 101, reportedAt: 5, source: 'flow' } },
      negative: { measure_battery: { value: -1, reportedAt: 5, source: 'flow' } },
    });

    expect(Object.keys(parsed)).toEqual(['ok']);
  });
});

describe('readFlowReportedCapabilitiesForDevice', () => {
  it('returns the per-device entry for a tracked device', () => {
    const state = parseFlowReportedCapabilities({
      'device-a': { onoff: { value: false, reportedAt: 9, source: 'flow' } },
    });

    expect(readFlowReportedCapabilitiesForDevice(state, 'device-a')).toEqual({
      onoff: { value: false, reportedAt: 9, source: 'flow' },
    });
  });

  it('defaults to an empty (but defined) map for an untracked device', () => {
    const state = parseFlowReportedCapabilities({});
    expect(readFlowReportedCapabilitiesForDevice(state, 'missing')).toEqual({});
  });

  it('tolerates an undefined state', () => {
    expect(readFlowReportedCapabilitiesForDevice(undefined, 'missing')).toEqual({});
  });
});
