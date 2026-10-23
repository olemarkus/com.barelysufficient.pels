// The activity log collapses consecutive visually-identical entries into one
// row with a repeat caption, and a chip-only entry renders without an empty
// body paragraph.

import type { SettingsUiDeviceActivityEntry } from '../src/../../contracts/src/settingsUiApi';
import { collapseRepeatedLogEntries } from '../src/ui/deviceLogCollapse';
import { renderDeviceLogView } from '../src/ui/views/DeviceLogView';

const entry = (overrides: Partial<SettingsUiDeviceActivityEntry>): SettingsUiDeviceActivityEntry => ({
  id: 'event-1', deviceId: 'dev-1', deviceName: 'Heater', recordingStartedAtMs: 0,
  atMs: 0,
  stateMsg: 'Idle',
  stateTone: 'muted', stateKind: 'idle', powerMsg: null,
  usageMsg: 'Measured: 0.00 kW',
  statusMsg: '',
  ...overrides,
});

describe('collapseRepeatedLogEntries', () => {
  it('collapses a run of identical entries and keeps the run boundaries', () => {
    const entries = [
      entry({ atMs: 5000, statusMsg: 'Turned off' }),
      entry({ atMs: 4000 }),
      entry({ atMs: 3000 }),
      entry({ atMs: 2000 }),
      entry({ atMs: 1000, statusMsg: 'Turned off' }),
    ];
    const collapsed = collapseRepeatedLogEntries(entries);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0].occurrenceCount).toBe(1);
    expect(collapsed[1].occurrenceCount).toBe(3);
    expect(collapsed[1].entry.atMs).toBe(4000);
    expect(collapsed[1].firstAtMs).toBe(2000);
    expect(collapsed[2].occurrenceCount).toBe(1);
    // Only the tail run can be retention-truncated; the middle run is not.
    expect(collapsed[1].truncated).toBe(false);
  });

  it('does not collapse entries whose visible content differs', () => {
    const entries = [
      entry({ atMs: 2000, usageMsg: 'Measured: 0.60 kW' }),
      entry({ atMs: 1000, usageMsg: 'Measured: 0.00 kW' }),
    ];
    expect(collapseRepeatedLogEntries(entries)).toHaveLength(2);
  });
});

describe('collapseRepeatedLogEntries bursts', () => {
  const MIN = 60_000;
  const T = 100 * MIN;
  // Each entry as the recorder writes it: its own measurement, and a reason
  // that moves while the device is held.
  const at = (atMs: number, stateMsg: string, statusMsg = '') => entry({
    id: `e-${atMs}`, atMs, stateMsg, statusMsg, usageMsg: `Measured: ${atMs % 7}.00 kW`,
  });

  it('folds a turned-off, resuming, running burst into one row naming its states', () => {
    const collapsed = collapseRepeatedLogEntries([
      at(T + 20 * MIN, 'Running'),
      at(T + 19 * MIN, 'Resuming'),
      at(T + 14 * MIN, 'Limited', 'Waiting for available power'),
      at(T + 9 * MIN, 'Limited', 'Turned off to stay under your limit'),
      at(T + 8 * MIN, 'Running'),
      at(T + 7 * MIN, 'Resuming'),
      at(T + 2 * MIN, 'Limited', 'Turned off to stay under your limit'),
      at(T, 'Running'),
      at(T - 60 * MIN, 'Idle'),
    ]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]).toMatchObject({
      kind: 'burst',
      stateMsgs: ['Running', 'Limited', 'Resuming'],
      switchCount: 6,
      occurrenceCount: 8,
      firstAtMs: T,
      truncated: false,
    });
    expect(collapsed[0].entry.atMs).toBe(T + 20 * MIN);
  });

  it('keeps one turn-off and restore as ordinary history', () => {
    expect(collapseRepeatedLogEntries([
      at(T + 8 * MIN, 'Running'), at(T + 7 * MIN, 'Resuming'),
      at(T + 2 * MIN, 'Limited', 'Turned off to stay under your limit'), at(T, 'Running'),
    ])).toHaveLength(4);
  });

  it('keeps changes far apart in time, like a device following 15-minute price periods', () => {
    expect(collapseRepeatedLogEntries([
      at(T + 45 * MIN, 'Running'), at(T + 30 * MIN, 'Limited'), at(T + 15 * MIN, 'Running'), at(T, 'Limited'),
    ])).toHaveLength(4);
  });

  it('does not fold two devices together, or a device moving between more than three states', () => {
    const otherDevice = (atMs: number) => ({ ...at(atMs, 'Limited'), deviceId: 'dev-2' });
    expect(collapseRepeatedLogEntries([
      at(T + 3 * MIN, 'Running'), otherDevice(T + 2 * MIN), at(T + MIN, 'Running'), otherDevice(T),
    ])).toHaveLength(4);
    expect(collapseRepeatedLogEntries([
      at(T + 5 * MIN, 'Running'), at(T + 4 * MIN, 'Limited'), at(T + 3 * MIN, 'Idle'),
      at(T + 2 * MIN, 'Manual'), at(T + MIN, 'Running'), at(T, 'Limited'),
    ]).every((item) => item.kind === 'repeat')).toBe(true);
  });
});

describe('renderDeviceLogView', () => {
  it('renders repeat captions and omits empty body paragraphs', () => {
    const surface = document.createElement('div');
    renderDeviceLogView(surface, {
      state: {
        status: 'ready', persistence: 'stored',
        entries: [
          entry({ atMs: 3000 }),
          entry({ atMs: 2000 }),
          entry({ atMs: 1000 }),
        ],
      },
      formatTimestamp: (atMs) => `t${atMs}`,
    });
    const rows = surface.querySelectorAll('.device-log__entry');
    expect(rows).toHaveLength(1);
    // The single run here IS the tail run, so it carries the truncation wording.
    expect(surface.textContent).toContain('Seen 3 times — the log keeps only recent changes');
    // statusMsg is empty on every entry: no empty body paragraph rendered.
    expect(surface.querySelectorAll('.pels-text-body')).toHaveLength(0);
  });

  it('captions a folded burst with its states and how often it switched', () => {
    const surface = document.createElement('div');
    const at = (atMs: number, stateMsg: string) => entry({ id: `e-${atMs}`, atMs, stateMsg });
    renderDeviceLogView(surface, {
      state: {
        status: 'ready', persistence: 'stored',
        // The Idle entry an hour earlier is ordinary history, not part of the burst.
        entries: [at(3_840_000, 'Running'), at(3_780_000, 'Limited'), at(3_720_000, 'Running'),
          at(3_660_000, 'Limited'), at(0, 'Idle')],
      },
      formatTimestamp: (atMs) => `t${atMs}`,
    });

    expect(surface.querySelectorAll('.device-log__entry')).toHaveLength(2);
    expect(surface.textContent).toContain('Since t3660000, switched 3 times between Limited and Running');
  });
});
