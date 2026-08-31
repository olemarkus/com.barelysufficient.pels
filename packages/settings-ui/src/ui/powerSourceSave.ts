import { settingsPowerSourceSelect } from './dom.ts';
import {
  applySettingsPatch,
  callApi,
  getSetting,
  getSettingFresh,
} from './homey.ts';
import { POWER_SOURCE } from '../../../contracts/src/settingsKeys.ts';
import {
  SETTINGS_UI_HOMES_SAVE_PATH,
  type SettingsUiHomesSaveRefusal,
} from '../../../contracts/src/settingsUiHomes.ts';
import {
  composePowerSourceSaveRefusalLine,
  HOMES_POWER_SOURCE_SAVE_FAILED,
  POWER_SOURCE_PICK_METER_PROMPT,
} from '../../../shared-domain/src/homeAreaConfigRulesCopy.ts';
import {
  normalizePowerSource,
  refreshStaleDataBanner,
  hasConfirmedPowerSourcePaintSince,
  supersedeCapacityPowerSourcePaints,
  type PowerSource,
} from './capacity.ts';
import { getChosenWholeHomeMeterId, syncHomeyEnergyMeterVisibility } from './homeyEnergyMeter.ts';
import { logSettingsError } from './logging.ts';
import { ERROR_DURATION_MS, showToast, showToastError } from './toast.ts';

// The Power source write seam, carved out of `capacity.ts`: that file sits at
// its `max-lines` ceiling, and this is the one self-contained slice with its
// own module state (the in-flight guard below) and its own test file. The
// import points INTO capacity.ts, never back out, so there is no cycle.

// One power-source write at a time. The select is disabled while the request
// owns the persisted value, so rollback stays anchored to the last confirmed
// source (same discipline as the Whole-home meter picker).
let powerSourceWriteInFlight = false;

const rollbackPowerSourceSelect = (source: PowerSource): void => {
  if (settingsPowerSourceSelect) settingsPowerSourceSelect.value = source;
  syncHomeyEnergyMeterVisibility(source);
};

const markPowerSourceSelectUnavailable = (): void => {
  if (settingsPowerSourceSelect) settingsPowerSourceSelect.value = '';
  syncHomeyEnergyMeterVisibility('');
};

const settleFailedPowerSourceSave = (
  previous: PowerSource | null,
  confirmedPaintGeneration: number,
): void => {
  // A refresh that began after this request's opening fence may carry a
  // settings.set from the request itself (even when its transport callback
  // failed) or a newer write from another WebView. Preserve that confirmed,
  // authoritative paint instead of rolling the select back over it.
  if (hasConfirmedPowerSourcePaintSince(confirmedPaintGeneration)) return;
  if (previous === null) {
    // No source is authoritative enough to show as current. Leaving the user's
    // proposed value selected would present a refused/failed write as saved,
    // while normalizing absence to Flow would fabricate the opposite answer.
    markPowerSourceSelectUnavailable();
    return;
  }
  rollbackPowerSourceSelect(previous);
};

/**
 * Classify a persisted `power_source` read into a rollback anchor.
 *
 * `normalizePowerSource` is the RENDER default: it answers "which mode does the
 * app run in", and an unset setting runs as Flow. That is the wrong question
 * here. A rollback anchor has to be a source the user actually confirmed, and a
 * read that fulfils with `undefined`/`null` (the runtime never writes a default,
 * and a realtime cache invalidation can make an SDK read come back empty while
 * `homey_energy` is still persisted) is an ABSENT answer, not a Flow answer.
 * Collapsing it to `flow` would fabricate an anchor and let a refusal write a
 * source the user never chose into the select. `null` instead means unavailable
 * — the same "nothing trustworthy to roll back to" state as a rejected read.
 */
const resolveConfirmedPowerSource = (raw: unknown): PowerSource | null => (
  raw === 'homey_energy' || raw === 'flow' ? raw : null
);

const resolveSuccessfulPowerSourcePaint = async (next: PowerSource): Promise<PowerSource> => {
  // The POST may have committed before its callback arrives. Fence every load
  // already in flight, then re-read persistence so a later write from another
  // WebView wins over this request's older callback. Loads started after this
  // fence remain eligible to paint an even newer write afterwards.
  supersedeCapacityPowerSourcePaints();
  try {
    return resolveConfirmedPowerSource(await getSettingFresh(POWER_SOURCE)) ?? next;
  } catch {
    // The successful response still vouches for `next`; a transient reconcile
    // read must not turn that success into the failure/rollback path.
    return next;
  }
};

/** The atomic pair for Homey Energy (the draft guard proved a chosen meter). */
/**
 * The request is proven before it is built: the Homey Energy arm carries the
 * guard-resolved meter id, so this builder has no "no meter yet" arm — that
 * state never posts (it stays a draft at `savePowerSourceSetting`'s guard).
 */
type PowerSourceSaveRequest = { source: 'flow' } | { source: 'homey_energy'; meterDeviceId: string };

const buildPowerSourceSaveBody = (request: PowerSourceSaveRequest): Record<string, unknown> => (
  { op: 'set_power_source', ...request }
);

const paintSavedPowerSource = (savedSource: PowerSource): void => {
  applySettingsPatch({ [POWER_SOURCE]: savedSource });
  if (settingsPowerSourceSelect) settingsPowerSourceSelect.value = savedSource;
  syncHomeyEnergyMeterVisibility(savedSource);
  refreshStaleDataBanner();
};

const startHomeyEnergyDraft = async (): Promise<void> => {
  syncHomeyEnergyMeterVisibility('homey_energy');
  await showToast(POWER_SOURCE_PICK_METER_PROMPT, 'default');
};

/**
 * A typed refusal settles like a failure — roll back only to a source the
 * user confirmed (with no anchor, show the explicit unavailable state instead
 * of leaving the refused proposal selected as if it saved) — plus the one
 * refusal-specific posture: `meter_in_use`'s remedy is picking a DIFFERENT
 * meter, so the picker is re-revealed (draft posture) even though the select
 * itself rolled back. Error dwell: a refusal is an instruction to read.
 */
const settleRefusedPowerSourceSave = async (
  refusal: SettingsUiHomesSaveRefusal,
  previous: PowerSource | null,
  confirmedPaintGeneration: number,
): Promise<void> => {
  settleFailedPowerSourceSave(previous, confirmedPaintGeneration);
  if (refusal.reason === 'meter_in_use') {
    syncHomeyEnergyMeterVisibility('homey_energy');
  }
  await showToast(
    composePowerSourceSaveRefusalLine(refusal),
    'warn',
    { durationMs: ERROR_DURATION_MS },
  );
};

/**
 * Persist the Power source select through the guarded `ui_homes_save` seam.
 * The runtime refuses `flow` while meter areas are running (the same mutual
 * exclusion the area save path enforces from its side), so the write must go
 * where that answer lives instead of straight into settings. A typed refusal
 * rolls the select back and names the remedy.
 */
export const savePowerSourceSetting = async (): Promise<void> => {
  const select = settingsPowerSourceSelect;
  if (!select || powerSourceWriteInFlight) return;
  const next = normalizePowerSource(select.value);
  // Homey Energy persists atomically WITH the meter it will read. With no
  // meter chosen yet, the switch stays a DRAFT: reveal the picker and say
  // what finishes the switch — nothing is posted, nothing patched, and the
  // meter pick below posts the atomic pair. Navigating away leaves the
  // persisted source untouched.
  const chosenMeterDeviceId = next === 'homey_energy' ? getChosenWholeHomeMeterId() : null;
  if (next === 'homey_energy' && chosenMeterDeviceId === null) {
    await startHomeyEnergyDraft();
    return;
  }
  const request: PowerSourceSaveRequest = next === 'homey_energy' && chosenMeterDeviceId !== null
    ? { source: 'homey_energy', meterDeviceId: chosenMeterDeviceId }
    : { source: 'flow' };
  powerSourceWriteInFlight = true;
  select.disabled = true;
  // Fence every source read that started before this write. Reads started
  // afterwards remain eligible to publish a settings.set from this request or
  // a newer write from another WebView.
  const confirmedPaintGeneration = supersedeCapacityPowerSourcePaints();
  // Resolved inside the guard: this read can reject when a realtime settings
  // event just invalidated the cache and the SDK read fails, and the change
  // handler invokes this function fire-and-forget — an escape before the
  // try/finally used to produce no toast, no rollback, and a select stuck on
  // an unsaved choice. `null` = the pre-change source could not be resolved
  // (rejected read, or a fulfilled but unclassifiable one), so there is nothing
  // trustworthy to roll back to.
  let previous: PowerSource | null = null;
  try {
    previous = resolveConfirmedPowerSource(await getSetting(POWER_SOURCE));
    const response = await callApi<unknown>(
      'POST',
      SETTINGS_UI_HOMES_SAVE_PATH,
      buildPowerSourceSaveBody(request),
    );
    const responseRecord = typeof response === 'object' && response !== null
      ? response as Record<string, unknown>
      : null;
    if (typeof responseRecord?.ok !== 'boolean') {
      throw new Error('Invalid power-source save response.');
    }
    if (!responseRecord.ok) {
      await settleRefusedPowerSourceSave(
        responseRecord as SettingsUiHomesSaveRefusal,
        previous,
        confirmedPaintGeneration,
      );
      return;
    }
    const savedSource = await resolveSuccessfulPowerSourcePaint(next);
    paintSavedPowerSource(savedSource);
    await showToast('Power source saved.', 'ok');
  } catch (error) {
    // Roll the select back so the screen never shows an unsaved choice as
    // current alongside the failure toast. If the pre-change read itself
    // failed, neither source is trustworthy, so the control becomes explicitly
    // unavailable rather than fabricating a rollback target.
    settleFailedPowerSourceSave(previous, confirmedPaintGeneration);
    await logSettingsError('Failed to save power source', error, 'capacity');
    await showToastError(error, HOMES_POWER_SOURCE_SAVE_FAILED);
  } finally {
    powerSourceWriteInFlight = false;
    select.disabled = false;
  }
};
