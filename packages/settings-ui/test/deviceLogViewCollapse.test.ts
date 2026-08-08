// The activity log collapses consecutive visually-identical entries into one
// row with a repeat caption, and a chip-only entry renders without an empty
// body paragraph.

import type { SettingsUiDeviceLogEntry } from '../src/../../contracts/src/settingsUiApi';
import { collapseRepeatedLogEntries, renderDeviceLogView } from '../src/ui/views/DeviceLogView';

const entry = (overrides: Partial<SettingsUiDeviceLogEntry>): SettingsUiDeviceLogEntry => ({
  atMs: 0,
  stateMsg: 'Idle',
  stateTone: 'muted',
  usageMsg: 'Measured: 0.00 kW',
  statusMsg: '',
  ...overrides,
} as SettingsUiDeviceLogEntry);

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
    expect(collapsed[0].repeatCount).toBe(1);
    expect(collapsed[1].repeatCount).toBe(3);
    expect(collapsed[1].entry.atMs).toBe(4000);
    expect(collapsed[1].firstAtMs).toBe(2000);
    expect(collapsed[2].repeatCount).toBe(1);
  });

  it('does not collapse entries whose visible content differs', () => {
    const entries = [
      entry({ atMs: 2000, usageMsg: 'Measured: 0.60 kW' }),
      entry({ atMs: 1000, usageMsg: 'Measured: 0.00 kW' }),
    ];
    expect(collapseRepeatedLogEntries(entries)).toHaveLength(2);
  });
});

describe('renderDeviceLogView', () => {
  it('renders repeat captions and omits empty body paragraphs', () => {
    const surface = document.createElement('div');
    renderDeviceLogView(surface, {
      state: {
        status: 'ready',
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
    expect(surface.textContent).toContain('Repeated 3 times since t1000');
    // statusMsg is empty on every entry: no empty body paragraph rendered.
    expect(surface.querySelectorAll('.pels-text-body')).toHaveLength(0);
  });
});
