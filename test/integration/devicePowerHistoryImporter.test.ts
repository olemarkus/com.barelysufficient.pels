import { DevicePowerHistoryImporter } from '../../lib/device/devicePowerHistoryImporter';
import { DEVICE_POWER_HISTORY_IMPORT } from '../../packages/shared-domain/src/settings/devicePowerHistoryImport';
import {
  DEVICE_EXPECTED_POWER_OVERRIDES, DEVICE_POWER_SOURCES,
} from '../../packages/shared-domain/src/settings/settingsKeys';
import { MockSettings } from '../mocks/homey';

const NOW = Date.UTC(2026, 10, 25, 12);
const request = {
  kind: 'request', id: 'd70c0973-14aa-49fa-bcc3-644cb3308daf', deviceId: 'heater', sourceDeviceId: 'meter',
};
const ownerUri = 'homey:device:meter';
const logId = `${ownerUri}:energy_power`;
const log = { id: logId, ownerUri, type: 'number', units: 'W' };
const entries = {
  id: logId, uri: ownerUri, step: 5000,
  values: [2874, 2900, 2950].map((v, index) => ({ t: new Date(NOW - (3 - index) * 5000).toISOString(), v })),
};

function pendingHistory() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('device power history import', () => {
  const setup = (get = vi.fn(async (path: string): Promise<unknown> => (
    path === 'manager/insights/log' ? [log] : entries
  ))) => {
    const settings = new MockSettings();
    settings.set(DEVICE_POWER_SOURCES, { heater: 'meter' });
    const save = vi.fn(() => 'imported' as const);
    const devices = { readPowerHistorySource: vi.fn(() => 'meter'), saveLearnedPowerFromHistory: save };
    const refresh = vi.fn(async () => {});
    return { importer: new DevicePowerHistoryImporter(settings, devices, get, refresh), settings, get, save, refresh };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('ignores a stored request at startup and imports the selected meter only on an explicit request', async () => {
    const { importer, settings, get, save, refresh } = setup();
    settings.set(DEVICE_POWER_HISTORY_IMPORT, request);
    settings.set(DEVICE_EXPECTED_POWER_OVERRIDES, { heater: { kw: 2.5, ts: NOW, origin: 'settings' } });
    const detach = importer.attach();
    expect(get).not.toHaveBeenCalled();

    settings.set(DEVICE_POWER_HISTORY_IMPORT, request);
    await vi.advanceTimersByTimeAsync(0);
    expect(get.mock.calls).toEqual([
      ['manager/insights/log'],
      [`manager/insights/log/${ownerUri}/${logId}/entry?resolution=lastHour`],
    ]);
    expect(save).toHaveBeenCalledWith('heater', { kw: 2.874, sourceDeviceId: 'meter', observedAtMs: NOW - 5000 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(settings.get(DEVICE_POWER_HISTORY_IMPORT)).toEqual({ kind: 'result', id: request.id, outcome: 'imported' });
    expect(settings.get(DEVICE_EXPECTED_POWER_OVERRIDES)).toEqual({
      heater: { kw: 2.5, ts: NOW, origin: 'settings' },
    });
    detach();
  });

  it.each([
    { ...entries, step: 60_000 },
    { ...entries, values: entries.values.map(({ t }) => ({ t, v: 2900 })) },
    { ...entries, values: entries.values.map(({ v }) => ({ t: new Date(NOW - 5_000).toISOString(), v })) },
    { ...entries, values: entries.values.map(({ t }, index) => ({ t, v: 2 + index })) },
  ])('rejects coarse, repeated, duplicate or standby-only history instead of establishing a peak', async (history) => {
    const { importer, settings, save } = setup(vi.fn(async (path: string) => (
      path === 'manager/insights/log' ? [log] : history
    )));
    const detach = importer.attach();
    settings.set(DEVICE_POWER_HISTORY_IMPORT, request);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).not.toHaveBeenCalled();
    expect(settings.get(DEVICE_POWER_HISTORY_IMPORT)).toEqual({
      kind: 'result', id: request.id, outcome: 'history_unavailable',
    });
    detach();
  });

  it('drops a pending import when the meter assignment changes and changes back', async () => {
    const pending = pendingHistory();
    const { importer, settings, save } = setup(vi.fn(async (path: string) => (
      path === 'manager/insights/log' ? [log] : pending.promise
    )));
    const detach = importer.attach();
    settings.set(DEVICE_POWER_HISTORY_IMPORT, request);
    await vi.advanceTimersByTimeAsync(0);
    // A delayed Homey notification can arrive when the stored source is already back to the first ID.
    settings.emit('set', DEVICE_POWER_SOURCES);
    pending.resolve(entries);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).not.toHaveBeenCalled();
    expect(settings.get(DEVICE_POWER_HISTORY_IMPORT)).toEqual({
      kind: 'result', id: request.id, outcome: 'source_changed',
    });
    detach();
  });

  it('does not apply a history response received after the deadline', async () => {
    const pending = pendingHistory();
    const { importer, settings, save } = setup(vi.fn(async (path: string) => (
      path === 'manager/insights/log' ? [log] : pending.promise
    )));
    const detach = importer.attach();
    settings.set(DEVICE_POWER_HISTORY_IMPORT, request);
    await vi.advanceTimersByTimeAsync(15_000);
    pending.resolve(entries);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).not.toHaveBeenCalled();
    expect(settings.get(DEVICE_POWER_HISTORY_IMPORT)).toEqual({
      kind: 'result', id: request.id, outcome: 'history_unavailable',
    });
    detach();
  });
});
