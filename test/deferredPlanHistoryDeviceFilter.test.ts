// Unit tests for the past-tasks device-filter shared-domain helpers (v2.7.4
// PR-19). Three concerns: unique-device derivation order, list narrowing
// (including stale-filter self-heal), and the active-filter empty-state copy.
// All three feed the chip-row affordance on the past-tasks list — keeping the
// helpers in shared-domain so the UI and runtime log breadcrumbs render
// identical strings (per `feedback_ui_text_shared_with_logs.md`).
import {
  filterPlanHistoryByDevice,
  formatSmartTaskHistoryDeviceFilterEmpty,
  resolveSmartTaskHistoryFilterDevices,
} from '../packages/shared-domain/src/deferredPlanHistoryDeviceFilter';
import type {
  DeferredObjectivePlanHistoryEntry,
} from '../packages/contracts/src/deferredObjectivePlanHistory';

type EntryShape = Pick<DeferredObjectivePlanHistoryEntry, 'deviceId' | 'deviceName'>;

const buildEntry = (deviceId: string, deviceName: string | null = null): EntryShape => ({
  deviceId,
  deviceName: deviceName ?? deviceId,
});

describe('resolveSmartTaskHistoryFilterDevices', () => {
  it('returns one entry per unique device id in first-seen order', () => {
    const result = resolveSmartTaskHistoryFilterDevices([
      buildEntry('dev_a', 'Boiler'),
      buildEntry('dev_b', 'Connected 300'),
      buildEntry('dev_a', 'Boiler'),
      buildEntry('dev_c', 'Tesla'),
    ]);
    expect(result.map((d) => d.deviceId)).toEqual(['dev_a', 'dev_b', 'dev_c']);
    expect(result.map((d) => d.deviceName)).toEqual(['Boiler', 'Connected 300', 'Tesla']);
  });

  it('falls back to deviceId when deviceName is null', () => {
    const result = resolveSmartTaskHistoryFilterDevices([
      { deviceId: 'dev_a', deviceName: null },
    ]);
    expect(result).toEqual([{ deviceId: 'dev_a', deviceName: 'dev_a' }]);
  });

  it('returns an empty list for an empty input', () => {
    expect(resolveSmartTaskHistoryFilterDevices([])).toEqual([]);
  });
});

describe('filterPlanHistoryByDevice', () => {
  const entries: ReadonlyArray<{ deviceId: string; tag: string }> = [
    { deviceId: 'dev_a', tag: 'a1' },
    { deviceId: 'dev_b', tag: 'b1' },
    { deviceId: 'dev_a', tag: 'a2' },
  ];

  it('returns the entries unchanged when deviceId is null (the "All" case)', () => {
    const result = filterPlanHistoryByDevice(entries, null);
    expect(result.map((e) => e.tag)).toEqual(['a1', 'b1', 'a2']);
  });

  it('narrows to a single device when deviceId matches', () => {
    const result = filterPlanHistoryByDevice(entries, 'dev_a');
    expect(result.map((e) => e.tag)).toEqual(['a1', 'a2']);
  });

  it('self-heals to the unfiltered list when deviceId is unknown', () => {
    // Stale persisted filter pointing at a removed device must not leave the
    // user staring at an empty archive when entries exist for other devices.
    const result = filterPlanHistoryByDevice(entries, 'dev_z');
    expect(result.map((e) => e.tag)).toEqual(['a1', 'b1', 'a2']);
  });

  it('returns a defensive shallow copy so the caller can mutate freely', () => {
    const result = filterPlanHistoryByDevice(entries, null);
    expect(result).not.toBe(entries);
  });
});

describe('formatSmartTaskHistoryDeviceFilterEmpty', () => {
  it('renders the named-device empty-state copy', () => {
    expect(formatSmartTaskHistoryDeviceFilterEmpty('Connected 300'))
      .toBe('No past runs for Connected 300.');
  });

  it('trims surrounding whitespace from the device name', () => {
    expect(formatSmartTaskHistoryDeviceFilterEmpty('  Boiler  '))
      .toBe('No past runs for Boiler.');
  });

  it('falls back to a generic sentence when the name is empty', () => {
    expect(formatSmartTaskHistoryDeviceFilterEmpty('   '))
      .toBe('No past runs for this device.');
  });
});
