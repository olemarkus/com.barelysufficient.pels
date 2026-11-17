import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeviceTemporaryCard, type TemporarySchedulesRow,
} from '../src/ui/views/DeviceTemporaryCard.tsx';

const actions = {
  onStart: () => {}, onCancel: () => {}, onSave: () => {}, onEnd: () => {}, onDraftChange: () => {},
} as unknown as Parameters<typeof DeviceTemporaryCard>[0]['actions'];

const row = (patch: Partial<TemporarySchedulesRow>): TemporarySchedulesRow => ({
  deviceId: 'charger', count: 1, nextLabel: 'Tue 23:00', live: 1, needsAttention: 0, managed: true, override: null,
  ...patch,
});

const lineFor = (schedules: TemporarySchedulesRow): string => {
  const mount = document.createElement('div');
  document.body.append(mount);
  act(() => render(h(DeviceTemporaryCard, { override: null, smartTask: null, schedules, actions }), mount));
  return mount.querySelector('[slot="supporting-text"]')?.textContent ?? '';
};

afterEach(() => { document.body.replaceChildren(); });

describe('Device page Schedules row', () => {
  it('names the next run of a schedule that will run', () => {
    expect(lineFor(row({}))).toBe('1 for this device · next Tue 23:00');
  });

  it('says a schedule does not run while the device is not managed', () => {
    expect(lineFor(row({ managed: false, nextLabel: '' })))
      .toBe('1 for this device · not running while Managed is off');
  });

  it('leaves switched-off schedules alone on an unmanaged device', () => {
    expect(lineFor(row({ managed: false, live: 0, nextLabel: '' }))).toBe('1 for this device');
  });

  it('counts the schedules that need attention on a managed device', () => {
    expect(lineFor(row({ count: 2, needsAttention: 1 }))).toBe('2 for this device · 1 needs attention');
    expect(lineFor(row({ count: 3, live: 3, needsAttention: 2 }))).toBe('3 for this device · 2 need attention');
  });
});
