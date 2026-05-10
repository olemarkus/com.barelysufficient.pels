import { h, render } from 'preact';
import { describe, expect, it } from 'vitest';
import { DeadlinePlanHistory } from '../src/ui/views/DeadlinePlanHistory.tsx';
import type { DeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory';

const buildEntry = (overrides: Partial<DeferredObjectivePlanHistoryEntry> = {}): DeferredObjectivePlanHistoryEntry => ({
  deviceId: 'dev_water_heater',
  deviceName: 'Connected 300',
  objectiveKind: 'temperature',
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
  startedAtMs: Date.UTC(2026, 4, 6, 0, 0, 0),
  finalizedAtMs: Date.UTC(2026, 4, 6, 6, 0, 0),
  startProgressC: 50,
  startProgressPercent: null,
  finalProgressC: 65,
  finalProgressPercent: null,
  initialEnergyNeededKWh: 22.5,
  outcome: 'met',
  metAtMs: Date.UTC(2026, 4, 6, 4, 42, 0),
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  ...overrides,
});

const mountIntoBody = (vnode: ReturnType<typeof h>): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  render(vnode, mount);
  return mount;
};

describe('DeadlinePlanHistory', () => {
  it('shows the empty state when there are no entries', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [], timeZone: 'UTC' }));
    expect(mount.textContent).toContain('No past plans yet for this device.');
  });

  it('renders a met entry with an ok chip and a reached-at line', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [buildEntry()], timeZone: 'UTC' }));
    const chip = mount.querySelector('.plan-chip--ok');
    expect(chip?.textContent).toBe('Met');
    // Time formatting uses the system default locale via shared dateUtils helpers, so match
    // the leading HH:mm rather than a fully-rendered locale string.
    expect(mount.textContent).toMatch(/reached at 04:42/);
    expect(mount.textContent).toContain('50.0 °C → 65.0 °C');
    expect(mount.textContent).toContain('target 65.0 °C');
  });

  it('renders a missed entry with a warn chip and no reached-at line', () => {
    const entry = buildEntry({ outcome: 'missed', metAtMs: null, finalProgressC: 58 });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const chip = mount.querySelector('.plan-chip--warn');
    expect(chip?.textContent).toBe('Missed');
    expect(mount.textContent).not.toContain('reached at');
    expect(mount.textContent).toContain('50.0 °C → 58.0 °C');
  });

  it('shows the backup-hours pill when the run leaned on avoid buckets', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [buildEntry({ usedPolicyAvoid: true })],
      timeZone: 'UTC',
    }));
    expect(mount.textContent).toContain('Backup hours');
  });

  it('does not show the backup-hours pill on a clean run', () => {
    const mount = mountIntoBody(h(DeadlinePlanHistory, {
      entries: [buildEntry({ usedPolicyAvoid: false, usedDeadlineReserve: false })],
      timeZone: 'UTC',
    }));
    expect(mount.textContent).not.toContain('Backup hours');
  });

  it('renders an abandoned entry with a muted chip', () => {
    const entry = buildEntry({ outcome: 'abandoned', metAtMs: null });
    const mount = mountIntoBody(h(DeadlinePlanHistory, { entries: [entry], timeZone: 'UTC' }));
    const chip = mount.querySelector('.plan-chip--muted');
    expect(chip?.textContent).toBe('Stopped');
  });
});
