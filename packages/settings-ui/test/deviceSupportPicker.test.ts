import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeyDeviceListEntry } from '../../contracts/src/settingsUi/homeyDevices';
import { toDevicePickerRows } from '../src/ui/deviceSupportPicker';
import type { SettingsUiDeviceListItem } from '../src/ui/deviceUtils';
import { parseHomeyDeviceList } from '../src/ui/homeyDeviceList';
import {
  renderDeviceSupportPicker, resolveDevicePickerList, type DevicePickerList, type DeviceSupportPickerProps,
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
const meter = homeyDevice('meter', 'HAN reader', 'sensor', 'Hall');

const sectionIds = (list: DevicePickerList): [string, string[]][] => (
  'sections' in list ? list.sections.map((section) => [section.title, section.rows.map((row) => row.id)]) : []
);

afterEach(() => { render(null, document.body); document.body.innerHTML = ''; });

describe('device support picker rows', () => {
  it('calls every device on Devices listed, managed or not, and every other device unsupported', () => {
    expect(toDevicePickerRows(homeyDevices, pelsDevices, null).map((row) => [row.id, row.status, row.deviceType])).toEqual([
      ['heater', 'listed', 'Heater'],
      ['socket', 'listed', 'Socket'],
      ['relay', 'unsupported', 'Light'],
      ['fan', 'unsupported', 'Fan'],
    ]);
    const [classless] = toDevicePickerRows([{ ...meter, class: undefined }], [], null);
    expect(classless?.deviceType).toBeNull();
  });

  it('offers only devices PELS does not support, grouped by zone with devices without a zone last', () => {
    const rows = toDevicePickerRows([...homeyDevices, meter], pelsDevices, 'meter');
    expect(rows.find((row) => row.id === 'meter')?.status).toBe('power_source');
    const list = resolveDevicePickerList(rows, '');
    expect(list.kind).toBe('requestable');
    expect(sectionIds(list)).toEqual([['Basement', ['relay']], ['No zone', ['fan']]]);
    // Search reaches the zone as well as the name.
    expect(sectionIds(resolveDevicePickerList(rows, 'relay'))).toEqual([['Basement', ['relay']]]);
    expect(sectionIds(resolveDevicePickerList(rows, 'basement'))).toEqual([['Basement', ['relay']]]);
  });

  it('names the supported devices a search finds when it finds no device to request', () => {
    const rows = toDevicePickerRows([...homeyDevices, meter], pelsDevices, 'meter');
    const list = resolveDevicePickerList(rows, 'hall');
    expect(list.kind).toBe('supported');
    expect(sectionIds(list)).toEqual([['Already on Devices', ['heater']], ['Whole-home meter', ['meter']]]);
    expect(resolveDevicePickerList(rows, 'no such device')).toEqual({ kind: 'no_match' });
    expect(resolveDevicePickerList(rows.filter((row) => row.status !== 'unsupported'), ''))
      .toEqual({ kind: 'all_supported' });
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
  const rows = toDevicePickerRows([...homeyDevices, meter], pelsDevices, 'meter');
  const mount = (read: DeviceSupportPickerProps['read'], query = '') => {
    const surface = document.createElement('div');
    document.body.append(surface);
    const props: DeviceSupportPickerProps = {
      read, query, onQuery: vi.fn(), onSelect: vi.fn(), onRetry: vi.fn(), onClearSearch: vi.fn(),
    };
    renderDeviceSupportPicker(surface, props);
    return { surface, props };
  };

  it('lists only devices to request, each with its device type, and passes the tapped row on', () => {
    const { surface, props } = mount({ state: 'ready', rows });
    expect(surface.querySelector('.pels-appbar__title')?.textContent).toBe('Request support');
    expect(surface.querySelector('[data-device-picker-id="heater"]')).toBeNull();
    expect(surface.querySelector('[data-device-picker-id="meter"]')).toBeNull();
    expect(surface.querySelector('.segmented')).toBeNull();
    const relay = surface.querySelector<HTMLElement>('[data-device-picker-id="relay"]');
    expect(relay?.querySelector('[slot="headline"]')?.textContent).toBe('Water heater relay');
    expect(relay?.querySelector('[slot="supporting-text"]')?.textContent).toBe('Light');
    expect(relay?.querySelector('[slot="end"]')).not.toBeNull();
    relay?.click();
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'relay', status: 'unsupported' }));
    expect(surface.querySelector('.pels-appbar__back')?.getAttribute('data-settings-target')).toBe('devices');
  });

  it('shows a search that finds only supported devices under where they are, and clears it', () => {
    const { surface, props } = mount({ state: 'ready', rows }, 'hall');
    expect(surface.querySelector('[aria-label="Already on Devices"] [data-device-picker-id="heater"]')
      ?.querySelector('[slot="supporting-text"]')?.textContent).toBe('Hall');
    // The meter opens Power source through the app-wide settings link.
    const meterRow = surface.querySelector<HTMLElement>('[aria-label="Whole-home meter"] [data-device-picker-id="meter"]');
    expect(meterRow?.dataset).toMatchObject({
      settingsTarget: 'limits', settingsAnchor: '#settings-power-source', settingsHomeScope: 'main',
    });
    expect(surface.textContent).toContain('A device has to be added to Homey before PELS can see it.');
    surface.querySelector<HTMLElement>('[data-device-picker-action="clear-search"]')?.click();
    expect(props.onClearSearch).toHaveBeenCalledTimes(1);
  });

  it('says when nothing matches, and when every Homey device is supported', () => {
    expect(mount({ state: 'ready', rows }, 'no such device').surface.textContent).toContain('No devices match.');
    const supported = mount({ state: 'ready', rows: rows.filter((row) => row.status !== 'unsupported') });
    expect(supported.surface.textContent).toContain('PELS supports every device in Homey.');
    expect(supported.surface.querySelector('[data-device-picker-action="clear-search"]')).toBeNull();
  });

  it('says when Homey could not be read and offers another try', () => {
    const { surface, props } = mount({ state: 'unavailable' });
    expect(surface.textContent).toContain('Could not load devices from Homey.');
    surface.querySelector<HTMLElement>('[data-device-picker-action="retry"]')?.click();
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });
});
