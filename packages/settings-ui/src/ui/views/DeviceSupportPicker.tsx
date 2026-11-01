import { render } from 'preact';
import { AppBar } from './AppBar.tsx';
import { MdFilledTextField, MdList, MdListItem, MdOutlinedButton, MdTextButton } from './materialWebJSX.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';

/**
 * Where a Homey device stands with PELS: on Devices and managed, on Devices
 * but not managed, or not on Devices at all because PELS does not support it.
 */
export type DevicePickerStatus = 'managed' | 'listed' | 'unsupported';

export type DevicePickerRow = {
  id: string;
  name: string;
  /** `null` when Homey's zone is not known. */
  zoneName: string | null;
  /** Homey's device type, as a label. */
  typeLabel: string;
  status: DevicePickerStatus;
};

export type DevicePickerFilter = 'all' | 'unsupported' | 'listed';

export type DevicePickerRead =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; rows: readonly DevicePickerRow[] };

export type DeviceSupportPickerProps = {
  read: DevicePickerRead;
  query: string;
  filter: DevicePickerFilter;
  onQuery(query: string): void;
  onFilter(filter: DevicePickerFilter): void;
  onSelect(row: DevicePickerRow): void;
  onRetry(): void;
  /** Clears the search and the filter. */
  onShowAll(): void;
};

const STATUS_LABELS: Record<DevicePickerStatus, string> = {
  managed: 'Managed',
  listed: 'Not managed',
  unsupported: 'Not supported',
};

const FILTER_OPTIONS: { value: DevicePickerFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'listed', label: 'Supported' },
  { value: 'unsupported', label: 'Not supported' },
];

const NO_ZONE = 'No zone';

const matchesFilter = (row: DevicePickerRow, filter: DevicePickerFilter): boolean => {
  if (filter === 'all') return true;
  return filter === 'unsupported' ? row.status === 'unsupported' : row.status !== 'unsupported';
};

const matchesQuery = (row: DevicePickerRow, query: string): boolean => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.name, row.zoneName ?? '', row.typeLabel, STATUS_LABELS[row.status]]
    .some((text) => text.toLocaleLowerCase().includes(needle));
};

/** The rows the filter and search leave, grouped by zone in name order, devices without a zone last. */
export const groupDevicePickerRows = (
  rows: readonly DevicePickerRow[],
  filter: DevicePickerFilter,
  query: string,
): { zone: string; rows: DevicePickerRow[] }[] => {
  const groups = new Map<string, DevicePickerRow[]>();
  for (const row of rows) {
    if (!matchesFilter(row, filter) || !matchesQuery(row, query)) continue;
    const zone = row.zoneName ?? NO_ZONE;
    groups.set(zone, [...(groups.get(zone) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === NO_ZONE || b === NO_ZONE) return Number(a === NO_ZONE) - Number(b === NO_ZONE);
      return a.localeCompare(b);
    })
    .map(([zone, zoneRows]) => ({ zone, rows: zoneRows.sort((a, b) => a.name.localeCompare(b.name)) }));
};

const fieldValue = (event: Event): string => (event.currentTarget as HTMLElement & { value: string }).value;

const DeviceRows = ({ read, query, filter, onSelect, onRetry, onShowAll }: DeviceSupportPickerProps) => {
  if (read.state === 'loading') return <p class="pels-text-supporting muted">Loading devices from Homey…</p>;
  if (read.state === 'unavailable') {
    return (
      <div class="device-picker__empty">
        <p class="pels-text-supporting">Could not load devices from Homey.</p>
        <MdOutlinedButton type="button" onClick={onRetry} data-device-picker-action="retry">Try again</MdOutlinedButton>
      </div>
    );
  }
  const groups = groupDevicePickerRows(read.rows, filter, query);
  if (groups.length === 0) {
    return (
      <div class="device-picker__empty">
        <p class="pels-text-supporting muted">No devices match. A device has to be added to Homey before PELS can see it.</p>
        <MdTextButton type="button" onClick={onShowAll} data-device-picker-action="show-all">Show all devices</MdTextButton>
      </div>
    );
  }
  return <>
    {groups.map((group) => (
      <section key={group.zone} class="device-picker__zone" aria-label={group.zone}>
        <h3 class="pels-text-section-title device-picker__zone-title">{group.zone}</h3>
        <MdList class="device-picker__list">
          {group.rows.map((row) => (
            <MdListItem key={row.id} type="button" class="device-picker__row"
              data-device-picker-id={row.id} data-device-picker-status={row.status}
              onClick={() => onSelect(row)}>
              <span slot="headline">{row.name}</span>
              <span slot="supporting-text">{`${row.typeLabel} · ${STATUS_LABELS[row.status]}`}</span>
            </MdListItem>
          ))}
        </MdList>
      </section>
    ))}
  </>;
};

const DeviceSupportPicker = (props: DeviceSupportPickerProps) => (
  <>
    <AppBar back={{ target: 'devices', label: 'Back to Devices' }} title="Find a device"
      lede="Every device in Homey. Tap a device PELS does not support to request support for it." />
    <div class="device-picker">
      <MdFilledTextField type="search" label="Search devices" value={props.query}
        supporting-text="Name, zone or type" data-device-picker-field="search"
        onInput={(event: Event) => props.onQuery(fieldValue(event))} />
      <SegmentedControl contentSized options={FILTER_OPTIONS} value={props.filter} ariaLabel="Show devices"
        onChange={props.onFilter} />
      <DeviceRows {...props} />
    </div>
  </>
);

export const renderDeviceSupportPicker = (surface: HTMLElement, props: DeviceSupportPickerProps): void => {
  render(<DeviceSupportPicker {...props} />, surface);
};
