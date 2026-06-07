import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { renderDeviceLogView } from '../src/ui/views/DeviceLogView.tsx';
import type { SettingsUiDeviceLogEntry } from '../../contracts/src/settingsUiApi';

const entry = (overrides: Partial<SettingsUiDeviceLogEntry> = {}): SettingsUiDeviceLogEntry => ({
  atMs: 1700000000000,
  powerMsg: 'on → off',
  stateMsg: 'Limited',
  usageMsg: 'Measured: 0.00 kW',
  statusMsg: 'Limiting to stay within budget',
  stateKind: 'held',
  stateTone: 'held',
  ...overrides,
});

const mountWith = (
  state: Parameters<typeof renderDeviceLogView>[1]['state'],
): HTMLElement => {
  const mount = document.createElement('div');
  renderDeviceLogView(mount, { state, formatTimestamp: () => '11-14 22:33' });
  return mount;
};

describe('DeviceLogView', () => {
  afterEach(() => {
    render(null, document.body);
  });

  it('shows a loading message while fetching', () => {
    expect(mountWith({ status: 'loading' }).textContent).toContain('Loading activity');
  });

  it('shows an error message when the fetch fails', () => {
    expect(mountWith({ status: 'error' }).textContent).toContain('Activity log unavailable');
  });

  it('shows an explanatory empty state when no entries are recorded', () => {
    const mount = mountWith({ status: 'ready', entries: [] });
    expect(mount.textContent).toContain('No activity recorded yet');
  });

  it('renders entries with the shared formatter wording and a tone chip', () => {
    const mount = mountWith({
      status: 'ready',
      entries: [entry({ stateMsg: 'Running', statusMsg: 'On track', stateTone: 'active' })],
    });
    const chip = mount.querySelector('.plan-chip');
    expect(chip?.textContent).toBe('Running');
    // active tone -> the same `good` chip modifier the live cards use.
    expect(chip?.classList.contains('plan-chip--good')).toBe(true);
    expect(chip?.getAttribute('data-state-tone')).toBe('active');
    expect(mount.textContent).toContain('On track');
    expect(mount.textContent).toContain('Measured: 0.00 kW');
    expect(mount.textContent).toContain('on → off');
    expect(mount.textContent).toContain('11-14 22:33');
  });

  it('omits the power line when the formatter produced none', () => {
    const mount = mountWith({
      status: 'ready',
      entries: [entry({ powerMsg: null })],
    });
    expect(mount.textContent).not.toContain('on → off');
    expect(mount.textContent).toContain('Measured: 0.00 kW');
  });

  it('maps the held tone to the limited chip modifier', () => {
    const mount = mountWith({ status: 'ready', entries: [entry({ stateTone: 'held' })] });
    expect(mount.querySelector('.plan-chip')?.classList.contains('plan-chip--limited')).toBe(true);
  });
});
