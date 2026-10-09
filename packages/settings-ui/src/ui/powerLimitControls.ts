import { resolveCapacityPeriodMinutes } from '../../../shared-domain/src/settings/capacityPeriod.ts';
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
  settingsCapacityMarginAlert,
  settingsCapacityReactionHint,
  type MdFilledTextFieldElement,
} from './dom.ts';

export const syncCapacityReactionHint = (limit: number, margin: number) => {
  if (!settingsCapacityReactionHint) return;
  // The result row's static label ("With these settings, safe pace starts each period at")
  // frames this as a ceiling derived from the current inputs, not an absolute
  // "safe pace now" — that live value is the Overview hero's job and can differ
  // when today's daily budget is the tighter constraint. This element carries
  // only the loud accent value so the two surfaces never contradict.
  const reactionAt = usableCapacityKw(limit, margin).toFixed(1);
  settingsCapacityReactionHint.textContent = `${reactionAt} kW`;
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

export const refreshPowerLimitControls = (): void => {
  if (settingsCapacityFields) settingsCapacityFields.hidden = settingsCapacityEnabledInput?.selected === false;
  if (settingsGridImportField) settingsGridImportField.hidden = settingsGridImportEnabledInput?.selected !== true;
  const limit = Number.parseFloat(settingsGridImportLimitInput?.value ?? '');
  if (settingsGridImportHint) settingsGridImportHint.textContent = isValidGridImportLimitKw(limit)
    ? `PELS starts reducing loads near ${gridImportTargetKw(limit).toFixed(2)} kW.`
    : GRID_IMPORT_LIMIT_PROMPT;
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
  syncCapacityReactionHint(limitKw, marginKw);
  renderMarginAlert(getMarginVsLimitError(limitKw, marginKw));
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

export const readPowerLimitSettings = (fallback: CapacityScalarSettings): PowerLimitSettings => {
  const capacityEnabled = settingsCapacityEnabledInput?.selected ?? fallback.capacityEnabled;
  return {
    capacityEnabled,
    gridImportLimitKw: settingsGridImportEnabledInput?.selected === true
      ? readNumberInput(settingsGridImportLimitInput, 'Grid import limit') : null,
    limitKw: capacityEnabled ? readNumberInput(settingsCapacityLimitInput, 'Hard cap') : fallback.limitKw,
    marginKw: capacityEnabled ? readNumberInput(settingsCapacityMarginInput, 'Safety margin') : fallback.marginKw,
    periodMinutes: resolveCapacityPeriodMinutes(Number(settingsCapacityPeriodSelect?.value), fallback.periodMinutes),
  };
};
