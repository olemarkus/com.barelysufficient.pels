import { describe, expect, it } from 'vitest';
import { appendDeviceStateChips } from '../src/ui/deviceListPresentation.ts';
import type { SettingsUiDeviceListItem } from '../src/ui/deviceUtils.ts';

const chipsFor = (device: Record<string, unknown>): string[] => {
  const container = document.createElement('div');
  appendDeviceStateChips(container, { id: 'heater', name: 'Heater', ...device } as unknown as SettingsUiDeviceListItem);
  return [...container.querySelectorAll('.device-row__state-chip')].map((chip) => chip.textContent ?? '');
};

describe('device list availability chip', () => {
  it('calls a device Homey reports unavailable Unavailable', () => {
    expect(chipsFor({ available: false })).toContain('Unavailable');
  });

  // The list type carries no state word, but the payload is a structural superset
  // of it, so a gray state word can still arrive.
  it('calls a device whose state PELS cannot read Unavailable, never Unknown', () => {
    const chips = chipsFor({ available: true, currentState: 'unknown' });
    expect(chips).toContain('Unavailable');
    expect(chips).not.toContain('Unknown');
  });
});
