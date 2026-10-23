import { act } from 'preact/test-utils';
import { renderActivityHistoryView } from '../src/ui/views/ActivityHistoryView';
import { parseDeviceActivityPayload } from '../src/ui/activityHistoryPayload';
import type { SettingsUiDeviceActivityEntry, SettingsUiDeviceLogPayload } from '../../contracts/src/settingsUiApi';

const entry = (overrides: Partial<SettingsUiDeviceActivityEntry> = {}): SettingsUiDeviceActivityEntry => ({
  id: 'e1', deviceId: 'heater', deviceName: 'Hall heater', atMs: 2000, recordingStartedAtMs: 1000,
  stateMsg: 'Limited', stateKind: 'held', stateTone: 'held', powerMsg: null,
  usageMsg: '18 °C · target 22 °C', statusMsg: 'Waiting for capacity', ...overrides,
});

const history = (entries: SettingsUiDeviceActivityEntry[]): SettingsUiDeviceLogPayload => ({
  version: 2, entries, retentionDays: 7, maxEntriesPerDevice: 100, maxEntries: 1000, persistence: 'stored',
});

describe('activity history', () => {
  it('returns to all devices when the selected device disappears from refreshed history', () => {
    const surface = document.createElement('div');
    const show = (entries: SettingsUiDeviceActivityEntry[]) => renderActivityHistoryView(surface, {
      state: { status: 'ready', payload: history(entries) }, formatTimestamp: String, onRefresh: async () => {},
    });
    const charger = entry({ id: 'charger-event', deviceId: 'charger', deviceName: 'Car charger' });
    act(() => show([entry(), charger]));
    const select = surface.querySelector('md-filled-select') as HTMLElement & { value: string };
    act(() => {
      select.value = 'charger';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(surface.querySelector('.device-log__entry')?.textContent).toContain('Car charger');

    act(() => show([entry()]));
    expect(select.value).toBe('');
    expect(surface.querySelector('.device-log__entry')?.textContent).toContain('Hall heater');
    expect(surface.textContent).not.toContain('No activity recorded yet');

    // A device reappearing later must not silently reactivate its old filter.
    act(() => show([entry(), charger]));
    expect(surface.querySelectorAll('.device-log__entry')).toHaveLength(2);
  });

  it('renders device names and separate recording sessions even when the states match', () => {
    const surface = document.createElement('div');
    renderActivityHistoryView(surface, {
      state: { status: 'ready', payload: history([
        entry(), entry({ id: 'e2', deviceId: 'charger', deviceName: 'Car charger' }),
        entry({ id: 'e3', atMs: 500, recordingStartedAtMs: 0 }),
      ]) },
      formatTimestamp: (atMs) => `t${atMs}`, onRefresh: async () => {},
    });
    expect(surface.querySelectorAll('.device-log__entry')).toHaveLength(3);
    expect(surface.querySelectorAll('.device-log__session')).toHaveLength(2);
    expect(surface.textContent).toContain('Car charger');
    expect(surface.textContent).toContain('Kept when PELS restarts');
  });

  it('shows saving trouble alongside the available history', () => {
    const surface = document.createElement('div');
    renderActivityHistoryView(surface, {
      state: { status: 'ready', payload: { ...history([entry()]), persistence: 'pending' } },
      formatTimestamp: String, onRefresh: async () => {},
    });
    expect(surface.textContent).toContain('waiting to be saved');
    expect(surface.textContent).toContain('Waiting for capacity');
  });

  it.each([null, {}, { version: 1, entriesByDeviceId: {} },
    { ...history([entry()]), entries: [entry({ atMs: Number.NaN })] },
    { ...history([entry()]), entries: [{ ...entry(), deviceName: null }] },
  ])('rejects malformed history instead of making it look empty: %j', (raw) => {
    expect(() => parseDeviceActivityPayload(raw)).toThrow('Activity history unavailable');
  });

  it('accepts an explicitly empty history', () => {
    expect(parseDeviceActivityPayload(history([])).entries).toEqual([]);
  });
});
