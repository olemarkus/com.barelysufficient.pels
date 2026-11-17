import { render } from 'preact';
import { AppBar } from './AppBar.tsx';
import { MdFilledTextField, MdList, MdListItem, MdOutlinedButton, MdTextButton } from './materialWebJSX.tsx';

/**
 * Where a Homey device stands with PELS: on Devices, the whole-home meter PELS
 * reads power from, or not on Devices at all because PELS does not support it.
 */
export type DevicePickerStatus = 'listed' | 'power_source' | 'unsupported';

export type DevicePickerRow = {
  id: string;
  name: string;
  /** `null` when Homey's zone is not known. */
  zoneName: string | null;
  /** Homey's device class as a label; `null` when Homey reports none. */
  deviceType: string | null;
  status: DevicePickerStatus;
};

export type DevicePickerRead =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; rows: readonly DevicePickerRow[] };

export type DeviceSupportPickerProps = {
  read: DevicePickerRead;
  query: string;
  onQuery(query: string): void;
  onSelect(row: DevicePickerRow): void;
  onRetry(): void;
  onClearSearch(): void;
};

/** One zone's devices, in name order. */
export type DevicePickerSection = {
  title: string;
  rows: DevicePickerRow[];
};

/**
 * What the page lists: every Homey device the search matches, grouped by zone,
 * whether PELS supports it or not. An owner who looks for a device they think
 * is missing finds it where they expect, and a row says where it stands, so a
 * device PELS already lists is opened rather than requested.
 * `allSupported` says that no Homey device is left to request.
 */
export type DevicePickerList =
  | { kind: 'devices'; sections: DevicePickerSection[]; allSupported: boolean }
  | { kind: 'no_match' };

const NO_ZONE = 'No zone';

/** The whole-home meter row's link, followed by the app-wide settings link handler. */
const POWER_SOURCE_LINK = {
  'data-settings-target': 'limits',
  'data-settings-anchor': '#settings-power-source',
  'data-settings-home-scope': 'main',
};

const NOT_IN_HOMEY = 'A device has to be added to Homey before PELS can see it.';

const matchesQuery = (row: DevicePickerRow, needle: string): boolean => (
  !needle || [row.name, row.zoneName ?? ''].some((text) => text.toLocaleLowerCase().includes(needle))
);

const byName = (a: DevicePickerRow, b: DevicePickerRow): number => a.name.localeCompare(b.name);

/** Devices grouped by zone in name order, devices without a zone last. */
const groupByZone = (rows: readonly DevicePickerRow[]): DevicePickerSection[] => {
  const groups = new Map<string, DevicePickerRow[]>();
  for (const row of rows) {
    const zone = row.zoneName ?? NO_ZONE;
    groups.set(zone, [...(groups.get(zone) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === NO_ZONE || b === NO_ZONE) return Number(a === NO_ZONE) - Number(b === NO_ZONE);
      return a.localeCompare(b);
    })
    .map(([zone, zoneRows]) => ({ title: zone, rows: zoneRows.sort(byName) }));
};

export const resolveDevicePickerList = (rows: readonly DevicePickerRow[], query: string): DevicePickerList => {
  const needle = query.trim().toLocaleLowerCase();
  const matches = rows.filter((row) => matchesQuery(row, needle));
  if (matches.length === 0) return { kind: 'no_match' };
  return {
    kind: 'devices',
    sections: groupByZone(matches),
    allSupported: rows.every((row) => row.status !== 'unsupported'),
  };
};

/** Under a row's name: its device type, and where PELS has it when PELS supports it. */
const rowDetail = (row: DevicePickerRow): string | null => {
  if (row.status === 'power_source') return 'Whole-home meter';
  if (row.status === 'listed') return row.deviceType ? `${row.deviceType} · On Devices` : 'On Devices';
  return row.deviceType;
};

const fieldValue = (event: Event): string => (event.currentTarget as HTMLElement & { value: string }).value;

const Chevron = () => (
  <svg slot="end" class="settings-nav-card__chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="m8.59 16.59 4.58-4.59-4.58-4.59L10 6l6 6-6 6-1.41-1.41z" fill="currentColor" />
  </svg>
);

const PickerSection = ({ section, onSelect }: { section: DevicePickerSection; onSelect(row: DevicePickerRow): void }) => (
  <section class="device-picker__zone" aria-label={section.title}>
    <h3 class="pels-text-title device-picker__zone-title">{section.title}</h3>
    <MdList class="device-picker__list">
      {section.rows.map((row) => {
        const detail = rowDetail(row);
        return (
          <MdListItem key={row.id} type="button" class="device-picker__row"
            data-device-picker-id={row.id} data-device-picker-status={row.status}
            {...(row.status === 'power_source' ? POWER_SOURCE_LINK : {})}
            onClick={() => onSelect(row)}>
            <span slot="headline">{row.name}</span>
            {detail && <span slot="supporting-text">{detail}</span>}
            <Chevron />
          </MdListItem>
        );
      })}
    </MdList>
  </section>
);

const ClearSearch = ({ onClearSearch }: { onClearSearch(): void }) => (
  <MdTextButton type="button" onClick={onClearSearch} data-device-picker-action="clear-search">Clear search</MdTextButton>
);

const DeviceRows = ({ read, query, onSelect, onRetry, onClearSearch }: DeviceSupportPickerProps) => {
  if (read.state === 'loading') return <p class="pels-text-supporting muted">Loading devices from Homey…</p>;
  if (read.state === 'unavailable') {
    return (
      <div class="device-picker__empty">
        <p class="pels-text-supporting">Could not load devices from Homey.</p>
        <MdOutlinedButton type="button" onClick={onRetry} data-device-picker-action="retry">Try again</MdOutlinedButton>
      </div>
    );
  }
  const list = resolveDevicePickerList(read.rows, query);
  if (list.kind === 'no_match') {
    return (
      <div class="device-picker__empty">
        <p class="pels-text-supporting muted">No devices match. {NOT_IN_HOMEY}</p>
        <ClearSearch onClearSearch={onClearSearch} />
      </div>
    );
  }
  return <>
    {list.allSupported && !query.trim() && (
      <p class="pels-text-supporting muted">PELS supports every device in Homey.</p>
    )}
    {list.sections.map((section) => <PickerSection key={section.title} section={section} onSelect={onSelect} />)}
    <div class="device-picker__empty">
      <p class="pels-text-supporting muted">{NOT_IN_HOMEY}</p>
      {query.trim() && <ClearSearch onClearSearch={onClearSearch} />}
    </div>
  </>;
};

const DeviceSupportPicker = (props: DeviceSupportPickerProps) => (
  <>
    <AppBar back={{ target: 'devices', label: 'Back to Devices' }} title="Request support"
      lede="Every device in Homey, by zone. Tap one PELS does not support to request support for it, or one marked On Devices to open it." />
    <div class="device-picker">
      <MdFilledTextField type="search" label="Search devices" value={props.query}
        supporting-text="Name or zone" data-device-picker-field="search"
        onInput={(event: Event) => props.onQuery(fieldValue(event))} />
      <DeviceRows {...props} />
    </div>
  </>
);

export const renderDeviceSupportPicker = (surface: HTMLElement, props: DeviceSupportPickerProps): void => {
  render(<DeviceSupportPicker {...props} />, surface);
};
