import {
  OVERRIDE_COPY as SHARED_OVERRIDE_COPY,
} from '../../../shared-domain/src/settings/deviceOverrideDraft.ts';

export {
  CLOCK_ALLOWANCE_MS, changeOverrideDraft, formatActiveOverride, formatOverrideEnd, formatOverrideEndLine,
  formatOverrideSmartTaskCreateNote, newOverrideDraft, OVERRIDE_END_OPTIONS,
  resolveOverrideDraft, resolveOverrideSmartTaskNote,
  type OverrideDraft, type OverrideEndChoice, type OverrideTemperatureRange,
} from '../../../shared-domain/src/settings/deviceOverrideDraft.ts';

export const OVERRIDE_COPY = {
  ...SHARED_OVERRIDE_COPY,
  hint: 'Hold a temperature for a while. Prices and mode changes do not move it; power limits still apply.',
  repeat: 'Repeat on a schedule',
  blocked: 'Override is not available while this device is set to Keep the new temperature. '
    + 'Change it under When the temperature changes outside PELS.',
} as const;

/** What the Smart task box appends to an open task's line while an override holds the device. */
export const resolveOverrideSmartTaskBoxNote = (untilMs: number, taskDeadlineAtMs: number): string => (
  taskDeadlineAtMs <= untilMs ? 'Ends without running: the override lasts past its ready-by time'
    : 'Waiting for the override to end'
);
