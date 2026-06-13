import {
  DeviceOverviewLogRecorder,
  DEVICE_OVERVIEW_LOG_MAX_DEVICES,
  DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE,
  resolveOverviewControlModel,
} from '../../lib/plan/deviceOverviewLog';
import type { SettingsUiDeviceLogEntry } from '../../packages/contracts/src/settingsUiApi';
import type { DeviceControlModel } from '../../packages/contracts/src/types';
import { buildPlanDevice, steppedPlanDevice } from '../utils/planTestUtils';

const entry = (atMs: number, overrides: Partial<SettingsUiDeviceLogEntry> = {}): SettingsUiDeviceLogEntry => ({
  atMs,
  powerMsg: 'on → off',
  stateMsg: 'Limited',
  usageMsg: 'Measured: 0.00 kW',
  statusMsg: 'Limiting to stay within budget',
  stateKind: 'held',
  stateTone: 'held',
  ...overrides,
});

describe('DeviceOverviewLogRecorder', () => {
  it('stores entries most-recent-first per device', () => {
    const recorder = new DeviceOverviewLogRecorder();
    recorder.record('dev-1', entry(100, { stateMsg: 'Running' }));
    recorder.record('dev-1', entry(200, { stateMsg: 'Limited' }));

    const { entriesByDeviceId } = recorder.getUiPayload();
    expect(entriesByDeviceId['dev-1'].map((e) => e.stateMsg)).toEqual(['Limited', 'Running']);
  });

  it('caps retained entries per device, dropping the oldest', () => {
    const recorder = new DeviceOverviewLogRecorder();
    const total = DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE + 5;
    for (let i = 0; i < total; i += 1) {
      recorder.record('dev-1', entry(i, { statusMsg: `s${i}` }));
    }
    const entries = recorder.getUiPayload().entriesByDeviceId['dev-1'];
    expect(entries).toHaveLength(DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE);
    // Newest first; the oldest 5 are gone.
    expect(entries[0].statusMsg).toBe(`s${total - 1}`);
    expect(entries.at(-1)?.statusMsg).toBe(`s${total - DEVICE_OVERVIEW_LOG_MAX_ENTRIES_PER_DEVICE}`);
  });

  it('retains history for devices that transiently leave the plan (no eager prune)', () => {
    // Memory is bounded solely by the LRU device cap, so a device dropping out
    // of a single plan pass (e.g. a transient SDK read blip) must keep its
    // history rather than have it wiped.
    const recorder = new DeviceOverviewLogRecorder();
    recorder.record('dev-1', entry(100));
    recorder.record('dev-2', entry(100));

    // dev-2 no longer appears in subsequent passes; only dev-1 keeps recording.
    recorder.record('dev-1', entry(200));

    const { entriesByDeviceId } = recorder.getUiPayload();
    expect(Object.keys(entriesByDeviceId).sort()).toEqual(['dev-1', 'dev-2']);
    expect(entriesByDeviceId['dev-2']).toHaveLength(1);
  });

  it('evicts the least-recently-active device past the device cap', () => {
    const recorder = new DeviceOverviewLogRecorder();
    // Fill to the cap; device "old" has the oldest newest-entry timestamp.
    recorder.record('old', entry(1));
    for (let i = 1; i < DEVICE_OVERVIEW_LOG_MAX_DEVICES; i += 1) {
      recorder.record(`dev-${i}`, entry(1000 + i));
    }
    // One past the cap pushes out "old".
    recorder.record('fresh', entry(9999));

    const ids = Object.keys(recorder.getUiPayload().entriesByDeviceId);
    expect(ids).toHaveLength(DEVICE_OVERVIEW_LOG_MAX_DEVICES);
    expect(ids).not.toContain('old');
    expect(ids).toContain('fresh');
  });

  it('returns defensive copies that do not mutate the buffer', () => {
    const recorder = new DeviceOverviewLogRecorder();
    recorder.record('dev-1', entry(100));
    const first = recorder.getUiPayload().entriesByDeviceId['dev-1'];
    first.push(entry(200));
    expect(recorder.getUiPayload().entriesByDeviceId['dev-1']).toHaveLength(1);
  });
});

describe('resolveOverviewControlModel', () => {
  it('keeps a stored-profile stepped device stepped even when the producer map says non-stepped', () => {
    // Regression: the raw-snapshot-derived map only marks NATIVE stepped devices.
    // A stored-profile stepped device is stepped on the decorated plan device but
    // absent-stepped in the map — `isSteppedLoadDevice` must win, or it mis-signs as
    // binary_power/temperature_target. (Under the old map-first order this returned
    // 'binary_power'.)
    const device = steppedPlanDevice({ id: 'heater' });
    const map = new Map<string, DeviceControlModel>([['heater', 'binary_power']]);
    expect(resolveOverviewControlModel(device, map).controlModel).toBe('stepped_load');
  });

  it('uses the producer map for a non-stepped temperature ↔ binary flip', () => {
    const device = buildPlanDevice({ id: 'thermo', deviceType: 'temperature' });
    expect(resolveOverviewControlModel(device, new Map([['thermo', 'temperature_target']])).controlModel)
      .toBe('temperature_target');
    expect(resolveOverviewControlModel(device, new Map([['thermo', 'binary_power']])).controlModel)
      .toBe('binary_power');
  });

  it('returns the device unchanged when it is neither stepped nor in the map', () => {
    const device = buildPlanDevice({ id: 'x' });
    expect(resolveOverviewControlModel(device, new Map()).controlModel).toBeUndefined();
  });
});
