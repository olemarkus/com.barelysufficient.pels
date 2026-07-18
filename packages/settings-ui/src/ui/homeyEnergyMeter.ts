import { createSelectOption } from './advanced.ts';
import {
  settingsHomeyEnergyMeterField,
  settingsHomeyEnergyMeterSelect,
} from './dom.ts';
import { callApi, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../../../contracts/src/settingsKeys.ts';

export type MeterDeviceEntry = { id: string; name: string; hasPower?: boolean };
export type MeterSelectEntry = { value: string; label: string };

/**
 * Hard-filter the device list to power-reporting devices: only a device
 * exposing a bare measure_power can serve as the whole-home meter, so listing
 * the rest just invites guaranteed-broken picks. Sorted by name. (Mirrors
 * toTemperatureDeviceOptions in weatherInsight.ts.)
 */
export const toMeterDeviceOptions = (devices: MeterDeviceEntry[]): MeterSelectEntry[] => (
  devices
    .filter((device) => device.hasPower === true)
    .map((device) => ({ value: device.id, label: device.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
);

/**
 * "Automatic" (Homey's marked whole-home meter) first, then the device
 * options. A saved id that is not in the device list gets an explicit entry so
 * the selection stays visibly configured instead of silently snapping back to
 * Automatic. "Not found" is only claimed once the list has actually loaded —
 * before that the entry reads as loading, so a saved meter never flashes as
 * broken on panel open. The label carries the consequence, not the raw device
 * id — only one such entry can exist, so the id disambiguates nothing (it
 * stays available on the option value and in the persisted setting).
 */
export const buildMeterSelectEntries = (
  options: MeterSelectEntry[],
  selectedId: string | null,
  devicesLoaded: boolean,
): MeterSelectEntry[] => {
  const entries = [{ value: '', label: 'Automatic' }, ...options];
  if (selectedId != null && !options.some((option) => option.value === selectedId)) {
    entries.push({
      value: selectedId,
      label: devicesLoaded ? 'Previously selected meter (not found in Homey)' : 'Selected meter (loading…)',
    });
  }
  return entries;
};

let pickerDevices: MeterSelectEntry[] | null = null;
let pickerDevicesLoading = false;
let selectedMeterId: string | null = null;
let lastRenderSignature: string | null = null;
let deferredRenderPending = false;

/** Whether an explicit meter is configured (vs Automatic) — feeds the stale-data hint. */
export const isHomeyEnergyMeterExplicit = (): boolean => selectedMeterId !== null;

const renderMeterOptions = (): void => {
  const select = settingsHomeyEnergyMeterSelect;
  if (!select) return;
  const entries = buildMeterSelectEntries(pickerDevices ?? [], selectedMeterId, pickerDevices !== null);
  const selectedValue = selectedMeterId ?? '';
  // Rebuilding options closes an open menu mid-selection, so skip when nothing
  // changed (same guard as renderAdvancedDeviceOptions in advanced.ts).
  const signature = JSON.stringify([entries, selectedValue]);
  if (signature === lastRenderSignature) return;
  // If the menu is open (e.g. the lazy device fetch lands while the user is
  // choosing), defer the rebuild to menu close instead of yanking it shut.
  // One pending listener is enough — the deferred run re-reads current state.
  if (select.open) {
    if (!deferredRenderPending) {
      deferredRenderPending = true;
      select.addEventListener('closed', () => {
        deferredRenderPending = false;
        renderMeterOptions();
      }, { once: true });
    }
    return;
  }
  lastRenderSignature = signature;
  select.replaceChildren(
    ...entries.map((entry) => createSelectOption(entry.value, entry.label, entry.value === selectedValue)),
  );
  select.value = selectedValue;
};

const ensureMeterDevicesLoaded = async (): Promise<void> => {
  if (pickerDevices !== null || pickerDevicesLoading) return;
  pickerDevicesLoading = true;
  try {
    const devices = await callApi<MeterDeviceEntry[] | null>('GET', '/homey_devices');
    const options = toMeterDeviceOptions(devices ?? []);
    // An empty result is not cached: it can be transient (backend still
    // wiring, meter just paired), and caching it would leave the picker empty
    // for the whole WebView session. A truly meter-less home simply re-fetches
    // on the next panel open.
    pickerDevices = options.length > 0 ? options : null;
    renderMeterOptions();
  } catch (error) {
    await logSettingsError('Failed to load devices for the whole-home meter picker', error, 'homeyEnergyMeter');
  } finally {
    pickerDevicesLoading = false;
  }
};

/**
 * Show/hide the picker (visible only for the homey_energy power source) and
 * adopt the persisted selection. The device list is fetched lazily on first
 * visibility, so flow-source homes never pay for it.
 */
export const syncHomeyEnergyMeterField = (powerSource: string, selectedId: string | null): void => {
  selectedMeterId = selectedId;
  syncHomeyEnergyMeterVisibility(powerSource);
};

/** Visibility-only variant for callers that don't re-read the setting (uses the stored selection). */
export const syncHomeyEnergyMeterVisibility = (powerSource: string): void => {
  const visible = powerSource === 'homey_energy';
  if (settingsHomeyEnergyMeterField) settingsHomeyEnergyMeterField.hidden = !visible;
  if (!visible) return;
  renderMeterOptions();
  void ensureMeterDevicesLoaded();
};

const handleMeterSelectionChange = async (): Promise<void> => {
  const select = settingsHomeyEnergyMeterSelect;
  if (!select) return;
  const next = select.value === '' ? null : select.value;
  if (next === selectedMeterId) return;
  const previous = selectedMeterId;
  selectedMeterId = next;
  try {
    await setSetting(HOMEY_ENERGY_METER_DEVICE_ID, next);
    await showToast('Whole-home meter saved.', 'ok');
  } catch (error) {
    // Roll the select back so the screen never shows an unsaved choice as
    // current alongside the failure toast.
    selectedMeterId = previous;
    lastRenderSignature = null;
    renderMeterOptions();
    await logSettingsError('Failed to save whole-home meter', error, 'homeyEnergyMeter');
    await showToastError(error, 'Failed to save whole-home meter.');
  }
};

export const initHomeyEnergyMeterHandlers = (): void => {
  settingsHomeyEnergyMeterSelect?.addEventListener('change', () => {
    void handleMeterSelectionChange();
  });
};
