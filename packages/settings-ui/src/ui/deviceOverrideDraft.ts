import type { DeviceOverride } from '../../../shared-domain/src/settings/deviceOverrides.ts';
import { MAX_DEVICE_OVERRIDE_MINUTES } from '../../../shared-domain/src/settings/deviceOverrides.ts';
import { scheduleInstant } from '../../../shared-domain/src/scheduleTime.ts';
import {
  formatTimeInTimeZone, getDateKeyInTimeZone, getZonedParts, shiftDateKey,
} from '../../../shared-domain/src/utils/dateUtils.ts';

/**
 * The Override card's draft and wording (`deviceDetail/overrideCard.ts`): the
 * temperature the owner types, when it ends, and how an override in force reads.
 * Times are in the Homey time zone.
 */
export type OverrideEndChoice = 'two_hours' | 'morning' | 'custom';

export type OverrideDraft = {
  temperature: string;
  end: OverrideEndChoice;
  /** The custom end's date (`YYYY-MM-DD`) and time (`HH:MM`). */
  date: string;
  at: string;
};

export const OVERRIDE_MORNING_AT = '08:00';
const TWO_HOURS_MS = 2 * 60 * 60_000;
// The phone's clock writes the end time and the Homey's reads it. This much
// difference between them is allowed for: an end is kept that far inside the
// maximum, and an override ended early is stored as having ended that long ago.
export const CLOCK_ALLOWANCE_MS = 5 * 60_000;
const MAX_MS = MAX_DEVICE_OVERRIDE_MINUTES * 60_000 - CLOCK_ALLOWANCE_MS;

export const OVERRIDE_COPY = {
  title: 'Override',
  hint: 'Hold a temperature for a while. Prices and mode changes do not move it; power limits still apply.',
  start: 'Set an override',
  change: 'Change',
  end: 'End now',
  save: 'Start override',
  saveChange: 'Save',
  thenBack: 'Then back to the mode target. Power limits still apply.',
  cancel: 'Cancel',
  repeat: 'Repeat on a schedule',
  temperatureLabel: 'Temperature (°C)',
  endLabel: 'Ends',
  blocked: 'Override is not available while this device is set to Keep the new temperature. '
    + 'Change it under When the temperature changes outside PELS.',
  started: 'Override started.',
  changed: 'Override changed.',
  ended: 'Override ended.',
  saveFailed: 'Could not save the override.',
  smartTaskWaits: 'The Smart task on this device waits until the override ends.',
  smartTaskEnds: 'The Smart task on this device ends without running: its ready-by time comes first.',
  smartTaskBoxWaiting: 'Waiting for the override to end',
  smartTaskBoxEnds: 'Ends without running: the override lasts past its ready-by time',
} as const;

const clock = (atMs: number, timeZone: string): string => (
  formatTimeInTimeZone(new Date(atMs), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, timeZone)
);

/** `21:30` for an end today, `Sun 21:30` for a later day. */
export const formatOverrideEnd = (untilMs: number, nowMs: number, timeZone: string): string => {
  const sameDay = getDateKeyInTimeZone(new Date(untilMs), timeZone) === getDateKeyInTimeZone(new Date(nowMs), timeZone);
  if (sameDay) return clock(untilMs, timeZone);
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(new Date(untilMs));
  return `${day} ${clock(untilMs, timeZone)}`;
};

const formatTemperature = (targetC: number): string => `${Number(targetC.toFixed(1))}°`;

/** The card's line for an override in force: `22° until Sun 21:30`. */
export const formatActiveOverride = (override: DeviceOverride, nowMs: number, timeZone: string): string => (
  `${formatTemperature(override.setting.targetC)} until ${formatOverrideEnd(override.untilMs, nowMs, timeZone)}`
);

/**
 * What an override means for the device's open Smart task: it waits, or, when
 * its ready-by time comes first, it ends without running. `untilMs` is `null`
 * while the draft has no valid end yet.
 */
export const resolveOverrideSmartTaskNote = (untilMs: number | null, taskDeadlineAtMs: number): string => (
  untilMs !== null && taskDeadlineAtMs <= untilMs ? OVERRIDE_COPY.smartTaskEnds : OVERRIDE_COPY.smartTaskWaits
);

/** For the New smart task page: the device has an override until then. */
export const formatOverrideSmartTaskCreateNote = (untilMs: number, nowMs: number, timeZone: string): string => (
  `This device has an override until ${formatOverrideEnd(untilMs, nowMs, timeZone)}. `
  + 'A Smart task waits until it ends; one that must be ready before then ends without running.'
);

/** What the Smart task box appends to an open task's line while an override holds the device. */
export const resolveOverrideSmartTaskBoxNote = (untilMs: number, taskDeadlineAtMs: number): string => (
  taskDeadlineAtMs <= untilMs ? OVERRIDE_COPY.smartTaskBoxEnds : OVERRIDE_COPY.smartTaskBoxWaiting
);

/** The next 08:00 in the Homey time zone. */
const nextMorning = (nowMs: number, timeZone: string): number | undefined => {
  const today = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  const todayAt = scheduleInstant(today, OVERRIDE_MORNING_AT, timeZone);
  if (todayAt !== undefined && todayAt > nowMs) return todayAt;
  return scheduleInstant(shiftDateKey(today, 1), OVERRIDE_MORNING_AT, timeZone);
};

// From mid-afternoon a change is usually for the night, so it ends in the morning.
const EVENING_FROM_HOUR = 15;

export const newOverrideDraft = (temperatureC: number | null, nowMs: number, timeZone: string): OverrideDraft => ({
  temperature: temperatureC === null ? '' : String(temperatureC),
  end: getZonedParts(new Date(nowMs), timeZone).hour >= EVENING_FROM_HOUR ? 'morning' : 'two_hours',
  date: getDateKeyInTimeZone(new Date(nowMs + 24 * 60 * 60_000), timeZone),
  at: OVERRIDE_MORNING_AT,
});

/** The draft for changing an override in force: its own temperature and end time. */
export const changeOverrideDraft = (override: DeviceOverride, timeZone: string): OverrideDraft => ({
  temperature: String(override.setting.targetC),
  end: 'custom',
  date: getDateKeyInTimeZone(new Date(override.untilMs), timeZone),
  at: clock(override.untilMs, timeZone),
});

/** The end the draft resolves to, spelled out: `Ends today 21:48`, `Ends tomorrow 08:00`, `Ends Sun 18:00`. */
export const formatOverrideEndLine = (untilMs: number, nowMs: number, timeZone: string): string => {
  const endDay = getDateKeyInTimeZone(new Date(untilMs), timeZone);
  const today = getDateKeyInTimeZone(new Date(nowMs), timeZone);
  if (endDay === today) return `Ends today ${clock(untilMs, timeZone)}`;
  if (endDay === shiftDateKey(today, 1)) return `Ends tomorrow ${clock(untilMs, timeZone)}`;
  return `Ends ${formatOverrideEnd(untilMs, nowMs, timeZone)}`;
};

/** The device's own setpoint range; a bound it does not declare is `null`. */
export type OverrideTemperatureRange = { min: number | null; max: number | null };

const outsideRange = (targetC: number, range: OverrideTemperatureRange): boolean => (
  (range.min !== null && targetC < range.min) || (range.max !== null && targetC > range.max)
);

const temperatureError = (range: OverrideTemperatureRange): string => (
  range.min !== null && range.max !== null
    ? `Enter a temperature from ${range.min} to ${range.max} °C.`
    : 'Enter a temperature.'
);

export type OverrideDraftResult = { ok: true; targetC: number; untilMs: number } | { ok: false; error: string };

const resolveEnd = (draft: OverrideDraft, nowMs: number, timeZone: string): number | undefined => {
  if (draft.end === 'two_hours') return nowMs + TWO_HOURS_MS;
  if (draft.end === 'morning') return nextMorning(nowMs, timeZone);
  return draft.date && draft.at ? scheduleInstant(draft.date, draft.at, timeZone) : undefined;
};

/** The draft as a temperature and an end time, or what the owner must correct. */
export const resolveOverrideDraft = (
  draft: OverrideDraft,
  range: OverrideTemperatureRange,
  nowMs: number,
  timeZone: string,
): OverrideDraftResult => {
  const targetC = draft.temperature.trim() === '' ? Number.NaN : Number(draft.temperature);
  if (!Number.isFinite(targetC) || outsideRange(targetC, range)) return { ok: false, error: temperatureError(range) };
  const untilMs = resolveEnd(draft, nowMs, timeZone);
  if (untilMs === undefined) return { ok: false, error: 'Choose a date and time that exists in the Homey time zone.' };
  if (untilMs <= nowMs) return { ok: false, error: 'Choose an end time in the future.' };
  if (untilMs - nowMs > MAX_MS) return { ok: false, error: 'Choose an end time within seven days.' };
  return { ok: true, targetC, untilMs };
};
