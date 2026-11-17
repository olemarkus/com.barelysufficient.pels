import {
  isCapacityPeriodMinutes,
  resolveCapacityPeriodMinutes,
} from '../../../shared-domain/src/settings/capacityPeriod.ts';
import type { CapacityScalarSettings, PowerLimitSettings } from '../../../contracts/src/capacitySettings.ts';
import { usableCapacityKw } from '../../../shared-domain/src/capacityAllowance.ts';
import { isValidGridImportLimitKw, gridImportTargetKw } from '../../../shared-domain/src/settings/powerLimits.ts';
import {
  settingsGridImportEnabledInput,
  settingsGridImportLimitInput,
  settingsGridImportField,
  settingsGridImportHint,
  settingsCapacityEnabledInput,
  settingsCapacityFields,
  settingsCapacityLimitInput,
  settingsCapacityMarginInput,
  settingsCapacityPeriodSelect,
  settingsCapacityMonthlyPeak,
  settingsCapacityFollowMonthPeakRow,
  settingsCapacityFollowMonthPeakInput,
  settingsCapacityMarginAlert,
  settingsCapacityReactionHint,
  settingsCapacityReactionLabel,
  settingsCapacityReactionNote,
  settingsCapacityMonthlyPeakValue,
  settingsCapacityMonthlyPeakNote,
  settingsCapacityMonthlyPeakState,
  settingsCapacityChoice,
  settingsCapacityChoiceText,
  settingsCapacityKeepButton,
  type MdFilledTextFieldElement,
} from './dom.ts';
import type { SettingsUiCapacityPeak } from '../../../contracts/src/settingsUi/power.ts';
import { capacityPeakNote, formatCapacityPeak, TRACKED_CAPACITY_PEAK_NOTE } from './capacityPeakRead.ts';
import {
  composeSafePaceSummaryCopy,
  formatHardCapKw,
  resolveMonthPeakReadout,
  type MonthPeakHold,
} from './monthPeakHoldCopy.ts';

// The scalars and month peak the form last showed: the safe-pace summary and
// the line under the month's peak read both, and each arrives on its own read.
let shownScalars: CapacityScalarSettings | null = null;
let shownCapacityPeak: SettingsUiCapacityPeak = { state: 'unavailable' };

const renderSafePaceSummary = (scalars: CapacityScalarSettings, hold: MonthPeakHold | null): void => {
  // The result row frames this as a ceiling derived from the saved settings,
  // not an absolute "safe pace now": that live value is the Overview hero's
  // job and can differ when today's daily budget is the tighter constraint.
  // The value element carries only the loud accent value so the two surfaces
  // never contradict. While this month's peak holds, the words around it say so.
  const copy = composeSafePaceSummaryCopy(hold);
  if (settingsCapacityReactionLabel) settingsCapacityReactionLabel.textContent = copy.label;
  if (settingsCapacityReactionNote) settingsCapacityReactionNote.textContent = copy.note;
  if (settingsCapacityReactionHint) {
    const reactionAt = usableCapacityKw(hold?.heldKw ?? scalars.limitKw, scalars.marginKw).toFixed(1);
    settingsCapacityReactionHint.textContent = `${reactionAt} kW`;
  }
};

const renderMonthPeakHold = (): void => {
  if (shownScalars === null) return;
  const { limitKw, periodMinutes, followMonthPeak, capacityEnabled } = shownScalars;
  const { hold, stateLine } = resolveMonthPeakReadout(limitKw, periodMinutes, followMonthPeak, shownCapacityPeak);
  renderSafePaceSummary(shownScalars, hold);
  // With Capacity limit off there is no hard cap for the peak to be above.
  const shownStateLine = capacityEnabled ? stateLine : null;
  if (settingsCapacityMonthlyPeakState) {
    settingsCapacityMonthlyPeakState.textContent = shownStateLine ?? '';
    settingsCapacityMonthlyPeakState.hidden = shownStateLine === null;
  }
};

/**
 * This month's highest completed quarter. An unavailable read is a no-op: the
 * last shown peak (or the template's "Peak unavailable") stays until a read
 * that knows the answer.
 */
export const syncMonthlyQuarterPeak = (peak: SettingsUiCapacityPeak): void => {
  if (peak.state === 'unavailable') return;
  shownCapacityPeak = peak;
  if (settingsCapacityMonthlyPeakValue) settingsCapacityMonthlyPeakValue.textContent = formatCapacityPeak(peak);
  if (settingsCapacityMonthlyPeakNote) {
    settingsCapacityMonthlyPeakNote.textContent = capacityPeakNote(peak, TRACKED_CAPACITY_PEAK_NOTE);
  }
  renderMonthPeakHold();
};

/**
 * Until the owner saves a hard cap, the field shows the built-in one, and the
 * form only saves a change: an owner happy with that number had no way to make
 * it theirs, and the Limits setup step stayed open. So while none is saved the
 * page says which number PELS runs on and offers to keep it.
 */
export const syncHardCapChoice = (configured: boolean, scalars: CapacityScalarSettings): void => {
  if (!settingsCapacityChoice) return;
  settingsCapacityChoice.hidden = configured;
  if (configured) return;
  const limit = formatHardCapKw(scalars.limitKw);
  if (settingsCapacityChoiceText) {
    // All three ways out, so the line never contradicts a setup step that
    // explains why this home can turn the limit off.
    settingsCapacityChoiceText.textContent = `Not chosen yet. PELS uses ${limit}. `
      + `Set the level you want to stay under, keep ${limit}, or turn off Capacity limit.`;
  }
  if (settingsCapacityKeepButton) settingsCapacityKeepButton.textContent = `Keep ${limit}`;
};

export const MARGIN_NOT_BELOW_LIMIT_MESSAGE
  = 'Safety margin must be less than the hard cap. Lower the margin to continue.';

// Stays silent when either number is empty or non-finite so partially-typed
// values don't flash an error mid-edit.
export const getMarginVsLimitError = (limit: number, margin: number): string | null => {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (!Number.isFinite(margin) || margin < 0) return null;
  if (margin >= limit) return MARGIN_NOT_BELOW_LIMIT_MESSAGE;
  return null;
};

export const renderMarginAlert = (message: string | null) => {
  if (!settingsCapacityMarginAlert) return;
  settingsCapacityMarginAlert.textContent = message ?? '';
  settingsCapacityMarginAlert.hidden = message === null;
};

const GRID_IMPORT_LIMIT_PROMPT = 'Enter a limit in kW to turn this on. PELS leaves a small automatic margin.';
const GRID_IMPORT_LIMIT_REJECTED = 'Enter a limit above 0 kW. PELS saves it once it is valid.';

export const refreshPowerLimitControls = (): void => {
  if (settingsCapacityFields) settingsCapacityFields.hidden = settingsCapacityEnabledInput?.selected === false;
  if (settingsGridImportField) settingsGridImportField.hidden = settingsGridImportEnabledInput?.selected !== true;
  const raw = settingsGridImportLimitInput?.value ?? '';
  const limit = Number.parseFloat(raw);
  const valid = isValidGridImportLimitKw(limit);
  // A typed value that is not a usable limit (0, negative) is named at the field,
  // where the owner is typing, rather than only in a toast after a failed save.
  const rejected = !valid && raw.trim() !== '';
  if (!settingsGridImportHint) return;
  settingsGridImportHint.classList.toggle('field__hint--alert', rejected);
  const promptText = rejected ? GRID_IMPORT_LIMIT_REJECTED : GRID_IMPORT_LIMIT_PROMPT;
  settingsGridImportHint.textContent = valid
    ? `PELS starts reducing loads near ${gridImportTargetKw(limit).toFixed(2)} kW.`
    : promptText;
};

export const syncPowerLimitSwitches = (scalars: CapacityScalarSettings): void => {
  if (settingsCapacityEnabledInput) settingsCapacityEnabledInput.selected = scalars.capacityEnabled;
  if (settingsGridImportEnabledInput) settingsGridImportEnabledInput.selected = scalars.gridImportLimitKw !== null;
  refreshPowerLimitControls();
};

export const syncCapacityLimitControls = (scalars: CapacityScalarSettings): void => {
  const { limitKw, marginKw, periodMinutes } = scalars;
  // The threshold first: the switch sync refreshes the hint from it.
  if (settingsGridImportLimitInput && scalars.gridImportLimitKw !== null) {
    settingsGridImportLimitInput.value = String(scalars.gridImportLimitKw);
  }
  syncPowerLimitSwitches(scalars);
  if (settingsCapacityLimitInput) settingsCapacityLimitInput.value = String(limitKw);
  if (settingsCapacityMarginInput) settingsCapacityMarginInput.value = String(marginKw);
  if (settingsCapacityPeriodSelect) settingsCapacityPeriodSelect.value = String(periodMinutes);
  if (settingsCapacityMonthlyPeak) settingsCapacityMonthlyPeak.hidden = periodMinutes !== 15;
  syncFollowMonthPeakControl(scalars);
  shownScalars = scalars;
  renderMonthPeakHold();
  renderMarginAlert(getMarginVsLimitError(limitKw, marginKw));
};

/** The month-peak switch, offered with the 15-minute period only. */
export const syncFollowMonthPeakControl = (scalars: CapacityScalarSettings): void => {
  if (settingsCapacityFollowMonthPeakRow) settingsCapacityFollowMonthPeakRow.hidden = scalars.periodMinutes !== 15;
  if (settingsCapacityFollowMonthPeakInput) settingsCapacityFollowMonthPeakInput.selected = scalars.followMonthPeak;
};

export const refreshLimitsValidationHints = () => {
  const limit = Number.parseFloat(settingsCapacityLimitInput?.value ?? '');
  const margin = Number.parseFloat(settingsCapacityMarginInput?.value ?? '');
  renderMarginAlert(getMarginVsLimitError(limit, margin));
  refreshPowerLimitControls();
};

const readNumberInput = (input: MdFilledTextFieldElement | null, label: string): number => {
  const value = parseFloat(input?.value ?? '');
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
  return value;
};

export const validatePowerLimitSettings = (settings: CapacityScalarSettings): void => {
  const { limitKw: limit, marginKw: margin, gridImportLimitKw, capacityEnabled } = settings;
  if (gridImportLimitKw !== null && !isValidGridImportLimitKw(gridImportLimitKw)) {
    throw new Error('Grid import limit must be positive.');
  }
  if (!capacityEnabled) return;
  // Validate limit: must be a finite positive number within reasonable bounds.
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Hard cap must be positive.');
  if (limit > 1000) throw new Error('Hard cap cannot exceed 1000 kW.');

  // Validate margin: must be a finite non-negative number within reasonable bounds.
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Safety margin must be non-negative.');
  if (margin >= limit) {
    renderMarginAlert(MARGIN_NOT_BELOW_LIMIT_MESSAGE);
    throw new Error(MARGIN_NOT_BELOW_LIMIT_MESSAGE);
  }
};

// Every reader below reads the switches the same way: Grid import limit is on only
// when its switch is selected.
const isGridImportSwitchOn = (): boolean => settingsGridImportEnabledInput?.selected === true;

/**
 * The Grid import limit switch is on but its field holds no usable limit yet:
 * saving now would fail, so the form waits for the owner to finish the value.
 */
export const isGridImportLimitIncomplete = (): boolean => (
  isGridImportSwitchOn()
  && !isValidGridImportLimitKw(Number.parseFloat(settingsGridImportLimitInput?.value ?? ''))
);


export const readPowerLimitSettings = (fallback: CapacityScalarSettings): PowerLimitSettings => {
  const capacityEnabled = settingsCapacityEnabledInput?.selected ?? fallback.capacityEnabled;
  return {
    capacityEnabled,
    gridImportLimitKw: isGridImportSwitchOn()
      ? readNumberInput(settingsGridImportLimitInput, 'Grid import limit') : null,
    limitKw: capacityEnabled ? readNumberInput(settingsCapacityLimitInput, 'Hard cap') : fallback.limitKw,
    marginKw: capacityEnabled ? readNumberInput(settingsCapacityMarginInput, 'Safety margin') : fallback.marginKw,
    periodMinutes: resolveCapacityPeriodMinutes(Number(settingsCapacityPeriodSelect?.value), fallback.periodMinutes),
  };
};

/**
 * What the Limits form shows right now, saved or not: which limits are switched
 * on, and each value, `null` while that value is not a valid number. A display
 * reads the switches here, so one unreadable value hides no limit and invents no
 * other: the Budget page's limits card shows the switched-on limits and renders an
 * unreadable value as unknown.
 */
export type PowerLimitFormView = {
  capacityEnabled: boolean;
  gridImportEnabled: boolean;
  limitKw: number | null;
  marginKw: number | null;
  gridImportLimitKw: number | null;
};

const readFiniteInput = (input: MdFilledTextFieldElement | null): number | null => {
  const value = Number.parseFloat(input?.value ?? '');
  return Number.isFinite(value) ? value : null;
};

/** The Limits form as `PowerLimitFormView`; `null` while the Capacity limit switch is not rendered. */
export const readPowerLimitFormView = (): PowerLimitFormView | null => {
  if (!settingsCapacityEnabledInput) return null;
  const gridImportLimitKw = readFiniteInput(settingsGridImportLimitInput);
  return {
    capacityEnabled: settingsCapacityEnabledInput.selected,
    gridImportEnabled: isGridImportSwitchOn(),
    limitKw: readFiniteInput(settingsCapacityLimitInput),
    marginKw: readFiniteInput(settingsCapacityMarginInput),
    gridImportLimitKw: gridImportLimitKw !== null && isValidGridImportLimitKw(gridImportLimitKw)
      ? gridImportLimitKw
      : null,
  };
};

/**
 * The Limits form's current values (saved or not) as power-limit settings, for a
 * surface that only computes from them and must not throw: the Budget page's
 * recommended daily maximum. `null` when the form cannot answer: the Capacity
 * limit switch is not rendered yet, or a value the settings carry is not a valid
 * number. Unlike `readPowerLimitSettings` it has no persisted fallback to fill in
 * with, so it never mixes saved values into the form's.
 */
export const readPowerLimitFormSettings = (): PowerLimitSettings | null => {
  const view = readPowerLimitFormView();
  const periodMinutes = Number(settingsCapacityPeriodSelect?.value);
  if (view === null || view.limitKw === null || view.marginKw === null || !isCapacityPeriodMinutes(periodMinutes)) {
    return null;
  }
  if (view.gridImportEnabled && view.gridImportLimitKw === null) return null;
  return {
    capacityEnabled: view.capacityEnabled,
    gridImportLimitKw: view.gridImportEnabled ? view.gridImportLimitKw : null,
    limitKw: view.limitKw,
    marginKw: view.marginKw,
    periodMinutes,
  };
};
