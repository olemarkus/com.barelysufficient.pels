import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeyDeviceListEntry } from '../../contracts/src/settingsUi/homeyDevices';
import { toDevicePickerRows } from '../src/ui/deviceSupportPicker';
import type { SettingsUiDeviceListItem } from '../src/ui/deviceUtils';
import { parseHomeyDeviceList } from '../src/ui/homeyDeviceList';
import {
  groupDevicePickerRows, renderDeviceSupportPicker, type DevicePickerRow, type DeviceSupportPickerProps,
} from '../src/ui/views/DeviceSupportPicker';

const homeyDevice = (id: string, name: string, deviceClass: string, zoneName: string | null): HomeyDeviceListEntry => ({
  id, name, class: deviceClass, zoneName, hasTemperature: false, hasPower: true,
});

const homeyDevices = [
  homeyDevice('heater', 'Hall heater', 'heater', 'Hall'),
  homeyDevice('socket', 'Garage socket', 'socket', 'Garage'),
  homeyDevice('relay', 'Water heater relay', 'light', 'Basement'),
  homeyDevice('fan', 'Bathroom fan', 'fan', null),
];
const pelsDevices = [
  { id: 'heater', managed: true },
  { id: 'socket', managed: false },
] as SettingsUiDeviceListItem[];

afterEach(() => { render(null, document.body); document.body.innerHTML = ''; });

describe('device support picker rows', () => {
  it('calls every device not on Devices unsupported, and the rest managed or not managed', () => {
    expect(toDevicePickerRows(homeyDevices, pelsDevices).map((row) => [row.id, row.status, row.typeLabel])).toEqual([
      ['heater', 'managed', 'Heater'],
      ['socket', 'listed', 'Socket'],
      ['relay', 'unsupported', 'Light'],
      ['fan', 'unsupported', 'Fan'],
    ]);
  });

  it('groups by zone with devices without a zone last, and filters by status and search', () => {
    const rows = toDevicePickerRows(homeyDevices, pelsDevices);
    expect(groupDevicePickerRows(rows, 'all', '').map((group) => group.zone))
      .toEqual(['Basement', 'Garage', 'Hall', 'No zone']);
    expect(groupDevicePickerRows(rows, 'unsupported', '').flatMap((group) => group.rows.map((row) => row.id)))
      .toEqual(['relay', 'fan']);
    expect(groupDevicePickerRows(rows, 'listed', '').flatMap((group) => group.rows.map((row) => row.id)))
      .toEqual(['socket', 'heater']);
    // Search reaches the zone and Homey's device type as well as the name.
    expect(groupDevicePickerRows(rows, 'all', 'light').flatMap((group) => group.rows.map((row) => row.id)))
      .toEqual(['relay']);
    expect(groupDevicePickerRows(rows, 'all', 'garage').flatMap((group) => group.rows.map((row) => row.id)))
      .toEqual(['socket']);
  });

  it('drops list entries without an id or a name from Homey', () => {
    expect(parseHomeyDeviceList([
      { id: 'relay', name: 'Relay', class: 'light', zoneName: 'Basement', hasPower: true },
      { id: '', name: 'No id' }, { name: 'Missing id' }, null,
    ])).toEqual([{ id: 'relay', name: 'Relay', class: 'light', zoneName: 'Basement', hasTemperature: false, hasPower: true }]);
    expect(parseHomeyDeviceList({ not: 'a list' })).toEqual([]);
  });
});

describe('device support picker view', () => {
  const mount = (read: DeviceSupportPickerProps['read'], query = '') => {
    const surface = document.createElement('div');
    document.body.append(surface);
    const props: DeviceSupportPickerProps = {
      read, query, filter: 'all', onQuery: vi.fn(), onFilter: vi.fn(), onSelect: vi.fn(), onRetry: vi.fn(),
      onShowAll: vi.fn(),
    };
    renderDeviceSupportPicker(surface, props);
    return { surface, props };
  };

  it('labels each device with its type and status and passes the tapped row on', () => {
    const rows: DevicePickerRow[] = toDevicePickerRows(homeyDevices, pelsDevices);
    const { surface, props } = mount({ state: 'ready', rows });
    const relay = surface.querySelector<HTMLElement>('[data-device-picker-id="relay"]');
    expect(relay?.textContent).toContain('Light · Not supported');
    relay?.click();
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'relay', status: 'unsupported' }));
    expect(surface.querySelector('.pels-appbar__back')?.getAttribute('data-settings-target')).toBe('devices');
  });

  it('says when Homey could not be read and offers another try', () => {
    const { surface, props } = mount({ state: 'unavailable' });
    expect(surface.textContent).toContain('Could not load devices from Homey.');
    surface.querySelector<HTMLElement>('[data-device-picker-action="retry"]')?.click();
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers every device again when the search matches none', () => {
    const { surface, props } = mount({ state: 'ready', rows: toDevicePickerRows(homeyDevices, pelsDevices) }, 'no such device');
    expect(surface.textContent).toContain('No devices match.');
    surface.querySelector<HTMLElement>('[data-device-picker-action="show-all"]')?.click();
    expect(props.onShowAll).toHaveBeenCalledTimes(1);
  });
});
