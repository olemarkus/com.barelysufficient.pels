// Browser-safe long deadline label for smart-task surfaces: "Today 16:00",
// "Tomorrow 07:00", "Sat 16:00" for the rest of this week, "16 May 16:00" past
// that. Pure Intl — no Date arithmetic across DST — so it is safe in both the
// app process (widget API handlers) and the browser. The day word is derived
// by comparing calendar-day indices in the SAME timezone the time half is
// formatted in, which keeps "Today"/"Tomorrow" consistent with the "HH:MM"
// regardless of the host's own zone.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const formatLocalHHMMFallback = (date: Date): string => (
  `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
);

// Exported so the create-smart-task widget can render its scheduled-hour window
// ("02:00–04:00") and the resolved ready-by echo from the same locale-aware
// formatter the deadline-long label uses — one source for "HH:MM" across the
// widget, the settings UI, and runtime log breadcrumbs.
export const formatLocalHHMM = (ms: number, timeZone: string | null): string => {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timeZone ?? undefined,
    }).format(date);
  } catch {
    return formatLocalHHMMFallback(date);
  }
};

const calendarDayIndex = (ms: number, timeZone: string | null): number => {
  try {
    const ymd = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timeZone ?? undefined,
    }).format(new Date(ms));
    const [y, m, d] = ymd.split('-').map(Number);
    // Guard against an unexpected `en-CA` separator / partial format in some
    // runtimes: a non-numeric part would make `Date.UTC` return NaN and produce
    // a bogus day index. Fall through to the local-date calc instead.
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      throw new Error('unexpected en-CA date parts');
    }
    return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
  } catch {
    const date = new Date(ms);
    return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
  }
};

export const formatSmartTaskDeadlineLong = (
  ms: number,
  nowMs: number,
  timeZone: string | null,
): string => {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  const timePart = formatLocalHHMM(ms, timeZone);
  const dayDiff = calendarDayIndex(ms, timeZone) - calendarDayIndex(nowMs, timeZone);
  if (dayDiff === 0) return `Today ${timePart}`;
  if (dayDiff === 1) return `Tomorrow ${timePart}`;
  try {
    if (dayDiff >= -6 && dayDiff <= 6) {
      const weekday = new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        timeZone: timeZone ?? undefined,
      }).format(date);
      return `${weekday} ${timePart}`;
    }
    const dayMonth = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: timeZone ?? undefined,
    }).format(date);
    return `${dayMonth} ${timePart}`;
  } catch {
    return formatLocalHHMMFallback(date);
  }
};

// One scheduled hour as the create-smart-task preview projects it.
export type ScheduledHourLike = { startsAtMs: number };

// Whether every hour starts exactly one hour after the previous (a single
// contiguous block we can render as a clean "HH:MM–HH:MM" range). One-hour and
// empty lists are trivially contiguous. Non-contiguous lists fall back to a
// comma-separated start list so a "02:00, 03:00, 14:00" plan isn't misdrawn as
// "02:00–15:00".
const hoursAreContiguous = (hours: readonly ScheduledHourLike[]): boolean => {
  for (let i = 1; i < hours.length; i += 1) {
    if (hours[i].startsAtMs - hours[i - 1].startsAtMs !== HOUR_MS) return false;
  }
  return true;
};

// The clock-hour window the preview would run, e.g. "02:00–04:00" (contiguous;
// last start + 1h is the end edge) or "02:00, 03:00, 14:00" (non-contiguous).
// Returns null when there are no scheduled hours. Caller sorts ascending (the
// preview contract guarantees ascending `startsAtMs`); this does not re-sort.
export const formatScheduledHoursWindow = (
  scheduledHours: readonly ScheduledHourLike[],
  timeZone: string | null,
): string | null => {
  if (scheduledHours.length === 0) return null;
  if (scheduledHours.length === 1) {
    return formatLocalHHMM(scheduledHours[0].startsAtMs, timeZone);
  }
  if (hoursAreContiguous(scheduledHours)) {
    const first = formatLocalHHMM(scheduledHours[0].startsAtMs, timeZone);
    const lastStart = scheduledHours[scheduledHours.length - 1].startsAtMs;
    const end = formatLocalHHMM(lastStart + HOUR_MS, timeZone);
    return `${first}–${end}`; // en-dash window
  }
  return scheduledHours.map((hour) => formatLocalHHMM(hour.startsAtMs, timeZone)).join(', ');
};

// The full preview "when" line pairing the clock-hour window with the resolved
// ready-by, e.g. "Scheduled 02:00–04:00 · Ready by Tomorrow 07:00". When the
// projection scheduled no hours yet, collapses to "Ready by Tomorrow 07:00" so
// the deadline still anchors the preview. `scheduledLabel` / `readyByLabel`
// come from `CREATE_SMART_TASK_WIDGET_COPY` so all the words stay sourced from
// the copy table. `deadlineLabel` is the pre-formatted long deadline
// ("Tomorrow 07:00").
export const formatSmartTaskScheduledLine = (params: {
  scheduledHours: readonly ScheduledHourLike[];
  deadlineLabel: string;
  timeZone: string | null;
  scheduledLabel: string;
  readyByLabel: string;
}): string => composeSmartTaskScheduledLine({
  scheduledWindowLabel: formatScheduledHoursWindow(params.scheduledHours, params.timeZone),
  deadlineLabel: params.deadlineLabel,
  scheduledLabel: params.scheduledLabel,
  readyByLabel: params.readyByLabel,
});

// Stitch a pre-formatted scheduled-hours window (already localised by the
// PRODUCER — e.g. the preview API formats it in the Homey timezone) with the
// pre-formatted ready-by label into the same "Scheduled 02:00–04:00 · Ready by
// Tomorrow 07:00" line. String-only: it does no timestamp/timezone math, so the
// consumer (widget) cannot drift the scheduled window into the browser's zone.
// `scheduledWindowLabel` null collapses to just the ready-by part.
export const composeSmartTaskScheduledLine = (params: {
  scheduledWindowLabel: string | null;
  deadlineLabel: string;
  scheduledLabel: string;
  readyByLabel: string;
}): string => {
  const readyByPart = `${params.readyByLabel} ${params.deadlineLabel}`;
  if (params.scheduledWindowLabel === null) return readyByPart;
  return `${params.scheduledLabel} ${params.scheduledWindowLabel} · ${readyByPart}`;
};

// Cost-headline subtext making the implicit "why these hours" explicit:
// "cheapest hours before 07:00". Pulls the time half off the pre-formatted long
// deadline label ("Tomorrow 07:00" → "07:00") so the subtext stays in lock-step
// with the ready-by the user picked, without re-deriving locale from the
// timestamp. ("hours" is plural by intent — it names the cheap-window concept,
// not a specific scheduled count.)
export const formatCheapestHoursSubtext = (deadlineLabel: string): string => {
  const timePart = deadlineLabel.match(/(\d{1,2}:\d{2})\s*$/);
  const tail = timePart ? `before ${timePart[1]}` : 'before the deadline';
  return `cheapest hours ${tail}`;
};
