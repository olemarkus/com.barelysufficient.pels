import { createSelectOption } from './advanced.ts';
import {
  settingsHomeyEnergyMeterField,
  settingsHomeyEnergyMeterSelect,
} from './dom.ts';
import { applySettingsPatch, callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { ERROR_DURATION_MS, showToast, showToastError } from './toast.ts';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../../../contracts/src/settingsKeys.ts';
import { HOMEY_ENERGY_METERS_PATH, type HomeyEnergyMeterEntry } from '../../../contracts/src/settingsUiApi.ts';
import {
  SETTINGS_UI_HOMES_SAVE_PATH,
  type SettingsUiHomesSaveRefusal,
  type SettingsUiHomesSaveResponse,
} from '../../../contracts/src/settingsUiHomes.ts';
import {
  composeDraftErrorLine,
  HOMES_MAIN_METER_SAVE_DEGRADED,
} from '../../../shared-domain/src/homesManagementCopy.ts';
import { HOMES_MAIN_METER_NEEDED_BY_AREAS } from '../../../shared-domain/src/homeAreaConfigRulesCopy.ts';

export type MeterSelectEntry = { value: string; label: string };

/**
 * The meters come straight from the Homey Energy live report (via
 * `/homey_energy_meters`) — the same seam a selection is read against — so
 * every option is a meter PELS can actually read. No capability/class filter:
 * that was a proxy over the full device list that could drop a readable meter
 * (the "only Automatic" bug) or offer an unreadable one. Sorted by name. A
 * previously saved selection absent from the current report is preserved via
 * the buildMeterSelectEntries passthrough, not this list.
 */
export const toMeterDeviceOptions = (meters: HomeyEnergyMeterEntry[]): MeterSelectEntry[] => (
  meters
    .map((meter) => ({ value: meter.id, label: meter.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
);

/**
 * "Automatic" (Homey's marked whole-home meter) first, then the report meters.
 * A saved id absent from the current report gets an explicit entry so the
 * selection stays visibly configured instead of silently snapping back to
 * Automatic. "Not found" is only claimed once the list has actually loaded —
 * before that the entry reads as loading, so a saved meter never flashes as
 * broken on panel open. The label carries the consequence, not the raw device
 * id — only one such entry can exist, so the id disambiguates nothing (it stays
 * available on the option value and in the persisted setting). A meter merely
 * silent this poll re-appears by name on a later fetch once the report lists it.
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
// One selection write at a time. The Material picker is disabled while the
// request owns the persisted selection, and the handler also rejects a
// programmatic overlapping change. That keeps rollback anchored to the last
// confirmed selection instead of a stale pre-request snapshot.
let meterSelectionWriteInFlight = false;

const setMeterSelectionWriteBusy = (busy: boolean): void => {
  meterSelectionWriteInFlight = busy;
  if (settingsHomeyEnergyMeterSelect) settingsHomeyEnergyMeterSelect.disabled = busy;
};

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

/** Re-render unconditionally: drop the signature cache, then render. */
const forceRenderMeterOptions = (): void => {
  lastRenderSignature = null;
  renderMeterOptions();
};

const ensureMeterDevicesLoaded = async (): Promise<void> => {
  if (pickerDevices !== null || pickerDevicesLoading) return;
  pickerDevicesLoading = true;
  try {
    const meters = await callApi<HomeyEnergyMeterEntry[] | null>('GET', HOMEY_ENERGY_METERS_PATH);
    const payload = meters ?? [];
    // An empty PAYLOAD is not cached: it can be transient (backend still
    // wiring, meter just paired, one poll where the report was empty), and
    // caching it would leave the picker empty for the whole WebView session —
    // it simply re-fetches on the next panel open.
    if (payload.length > 0) pickerDevices = toMeterDeviceOptions(payload);
    renderMeterOptions();
  } catch (error) {
    await logSettingsError('Failed to load meters for the whole-home meter picker', error, 'homeyEnergyMeter');
  } finally {
    pickerDevicesLoading = false;
  }
};

/** Adopt a freshly read selection without changing source-owned visibility. */
export const syncHomeyEnergyMeterSelection = (selectedId: string | null): void => {
  selectedMeterId = selectedId;
  if (settingsHomeyEnergyMeterField?.hidden === false) renderMeterOptions();
};

/** Visibility-only variant for callers that don't re-read the setting (uses the stored selection). */
export const syncHomeyEnergyMeterVisibility = (powerSource: string): void => {
  const visible = powerSource === 'homey_energy';
  if (settingsHomeyEnergyMeterField) settingsHomeyEnergyMeterField.hidden = !visible;
  if (!visible) return;
  renderMeterOptions();
  void ensureMeterDevicesLoaded();
};

const composeMainMeterSaveRefusal = (
  refusal: SettingsUiHomesSaveRefusal,
): string => {
  if (refusal.reason === 'meter_in_use') {
    return composeDraftErrorLine({ kind: 'meter_in_use', otherName: refusal.otherName });
  }
  if (refusal.reason === 'degraded') return HOMES_MAIN_METER_SAVE_DEGRADED;
  // Automatic while meter areas exist: the same requirement the area save path
  // enforces, said from the picker's side.
  if (refusal.reason === 'main_meter_required') return HOMES_MAIN_METER_NEEDED_BY_AREAS;
  return 'Failed to save whole-home meter.';
};

const handleMeterSelectionChange = async (): Promise<void> => {
  const select = settingsHomeyEnergyMeterSelect;
  if (!select) return;
  if (meterSelectionWriteInFlight) {
    forceRenderMeterOptions();
    return;
  }
  const next = select.value === '' ? null : select.value;
  if (next === selectedMeterId) return;
  const previous = selectedMeterId;
  setMeterSelectionWriteBusy(true);
  // Every branch below releases the lock as soon as ITS write is over, before
  // awaiting a toast dwell. `released` keeps the finally backstop from
  // clobbering the busy flag a newer write may have taken during that dwell:
  // the flag guards whichever write is in flight, not this handler's lifetime.
  let released = false;
  const releaseWriteLock = (): void => {
    if (released) return;
    released = true;
    setMeterSelectionWriteBusy(false);
  };
  try {
    const response = await callApi<SettingsUiHomesSaveResponse>(
      'POST',
      SETTINGS_UI_HOMES_SAVE_PATH,
      { op: 'set_main_meter', meterDeviceId: next },
    );
    if (!response.ok) {
      const refusal = response;
      // The write is over, so release the picker BEFORE the dwell: the refusal
      // tells the owner to pick another meter, but the select disables while
      // busy, so holding the lock through the five-second toast would bar the
      // user from acting on the very instruction on screen (same
      // release-before-dwell as `postHomesSaveOp` in homesSettings.ts).
      releaseWriteLock();
      forceRenderMeterOptions();
      // Error dwell: a refusal is an instruction to read, not an acknowledgement.
      await showToast(
        composeMainMeterSaveRefusal(refusal),
        'warn',
        { durationMs: ERROR_DURATION_MS },
      );
      return;
    }
    selectedMeterId = next;
    applySettingsPatch({ [HOMEY_ENERGY_METER_DEVICE_ID]: next });
    releaseWriteLock();
    forceRenderMeterOptions();
    await showToast('Whole-home meter saved.', 'ok');
  } catch (error) {
    // Roll the select back so the screen never shows an unsaved choice as
    // current alongside the failure toast.
    selectedMeterId = previous;
    // Same release-before-dwell as the refusal branch: the failed write is
    // over, so the failure toast must not keep the picker locked either.
    releaseWriteLock();
    forceRenderMeterOptions();
    await logSettingsError('Failed to save whole-home meter', error, 'homeyEnergyMeter');
    await showToastError(error, 'Failed to save whole-home meter.');
  } finally {
    releaseWriteLock();
  }
};

export const initHomeyEnergyMeterHandlers = (): void => {
  settingsHomeyEnergyMeterSelect?.addEventListener('change', () => {
    void handleMeterSelectionChange();
  });
};
