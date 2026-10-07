// Time-zone and hour/day bucketing helpers, the one copy both the runtime and
// the settings UI read. Every day, hour and quarter boundary PELS draws or
// buckets energy against comes from here, so the two cannot disagree on one.
//
// `Intl.DateTimeFormat` construction is the expensive part of every helper here
// — far more than the formatting — and `buildFlowDaySlots` calls them in a loop
// while it searches day boundaries and maps slots. These formatters are therefore
// memoized per time zone, as the runtime copy has always been. The zone set is
// bounded by the homes a user has, so the maps do not grow.
const zonedPartsFormatterByTimezone = new Map<string, Intl.DateTimeFormat>();
const offsetFormatterByTimezone = new Map<string, Intl.DateTimeFormat>();
const hourLabelFormatterByTimezone = new Map<string, Intl.DateTimeFormat>();

const getZonedPartsFormatter = (timeZone: string): Intl.DateTimeFormat => {
    const cached = zonedPartsFormatterByTimezone.get(timeZone);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        hourCycle: 'h23',
    });
    zonedPartsFormatterByTimezone.set(timeZone, formatter);
    return formatter;
};

const getOffsetFormatter = (timeZone: string): Intl.DateTimeFormat => {
    const cached = offsetFormatterByTimezone.get(timeZone);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: 'shortOffset',
        hour: '2-digit',
    });
    offsetFormatterByTimezone.set(timeZone, formatter);
    return formatter;
};

const getHourLabelFormatter = (timeZone: string): Intl.DateTimeFormat => {
    const cached = hourLabelFormatterByTimezone.get(timeZone);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    hourLabelFormatterByTimezone.set(timeZone, formatter);
    return formatter;
};

const timeZoneOffsetErrorLogged = new Set<string>();

/** A time zone `Intl` could not compute an offset for. Reported once per zone. */
export type TimeZoneOffsetFailure = {
    timeZone: string;
    primaryMessage: string;
    fallbackMessage: string;
};

// Where an offset failure goes. Each side with a real log points it there at
// startup: the app's `setRootLogger` (`lib/logging/logger.ts`) and the settings
// UI's boot (`logSettingsWarn`). `console.warn` is only the fallback before that,
// or where nothing installs one.
let reportTimeZoneOffsetFailure = (failure: TimeZoneOffsetFailure): void => {
    console.warn(
        `getTimeZoneOffsetMinutes: failed to compute offset for ${failure.timeZone}: `
        + `${failure.primaryMessage}; fallback failed: ${failure.fallbackMessage}`,
    );
};

export const reportTimeZoneOffsetFailuresTo = (report: (failure: TimeZoneOffsetFailure) => void): void => {
    reportTimeZoneOffsetFailure = report;
};
const DAY_START_SEARCH_WINDOW_MS = 72 * 60 * 60 * 1000;
// Dates advance and history readers visit older days, so unlike formatters this
// cache must be bounded across both dates and zones. Oldest entries leave first.
const MAX_DAY_START_CACHE_ENTRIES = 512;
const dayStartMsByTimezoneAndDate = new Map<string, number>();

const compareDateKeys = (left: string, right: string): number => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
};

const parseDateKey = (dateKey: string): { year: number; month: number; day: number } => {
    // A malformed key yields fewer than three parts; `Number(undefined)` is NaN,
    // which propagates through the caller's `Date.UTC` exactly as before.
    const [year, month, day] = dateKey.split('-');
    return { year: Number(year), month: Number(month), day: Number(day) };
};

export function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
    let primaryError: unknown;
    try {
        const parts = getOffsetFormatter(timeZone).formatToParts(date);
        const tzName = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
        const match = tzName.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
        if (!match) throw new Error('Missing GMT offset');
        const hours = Number(match[1]);
        const minutes = match[2] ? Number(match[2]) : 0;
        return hours * 60 + Math.sign(hours) * minutes;
    } catch (error) {
        primaryError = error;
    }

    try {
        const parts = getZonedParts(date, timeZone);
        if (![parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].every(Number.isFinite)) {
            throw new Error('Invalid zoned parts');
        }
        const utcCandidate = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        return Math.round((utcCandidate - date.getTime()) / 60000);
    } catch (fallbackError) {
        if (!timeZoneOffsetErrorLogged.has(timeZone)) {
            reportTimeZoneOffsetFailure({
                timeZone,
                primaryMessage: primaryError instanceof Error ? primaryError.message : String(primaryError),
                fallbackMessage: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            });
            timeZoneOffsetErrorLogged.add(timeZone);
        }
        return 0;
    }
}

/**
 * An hour of the day. The literal union is what makes an hour-indexed profile
 * checkable: `HourProfile[Hour]` is `number`, while `number[]` indexed by a
 * plain `number` is `number | undefined` under `noUncheckedIndexedAccess`
 * (`HourProfile` is in `lib/dailyBudget/hourProfile.ts`, its only user).
 */
export type Hour = 0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23;

const isHour = (value: number): value is Hour => Number.isInteger(value) && value >= 0 && value <= 23;

export function getZonedParts(date: Date, timeZone: string): {
    year: number;
    month: number;
    day: number;
    hour: Hour;
    minute: number;
    second: number;
} {
    const parts = getZonedPartsFormatter(timeZone).formatToParts(date);
    // One pass, nothing copied per part: this runs on every plan build.
    const map = new Map<string, string>();
    for (const part of parts) {
        if (part.type !== 'literal') map.set(part.type, part.value);
    }
    const rawHour = Number(map.get('hour'));
    // `hourCycle: 'h23'` yields 00-23, and the 24 -> 0 wrap covers the one
    // legacy formatter that reports midnight as 24. The guard is what lets the
    // hour leave here typed `Hour`, so every profile read downstream is checked.
    const wrapped = rawHour === 24 ? 0 : rawHour;
    if (!isHour(wrapped)) {
        // Unreachable with `hourCycle: 'h23'`, which always emits an hour part.
        // Refuse rather than name midnight: this value keys the tracker's
        // capacity buckets, so guessing would post energy to a real hour.
        throw new RangeError(`getZonedParts produced a non-hour: ${String(map.get('hour'))}`);
    }
    const hour: Hour = wrapped;
    return {
        year: Number(map.get('year')),
        month: Number(map.get('month')),
        day: Number(map.get('day')),
        hour,
        minute: Number(map.get('minute')),
        second: Number(map.get('second')),
    };
}

export function getDateKeyInTimeZone(date: Date, timeZone: string): string {
    const { year, month, day } = getZonedParts(date, timeZone);
    const yyyy = year.toString().padStart(4, '0');
    const mm = month.toString().padStart(2, '0');
    const dd = day.toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/** A `YYYY-MM-DD` key naming a real calendar day (`2026-02-30` and `2026-13-01` are not). */
export function isCalendarDateKey(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function shiftDateKey(dateKey: string, dayDelta: number): string {
    const { year, month, day } = parseDateKey(dateKey);
    return new Date(Date.UTC(year, month - 1, day + dayDelta, 0, 0, 0, 0)).toISOString().slice(0, 10);
}

export function getDateKeyStartMs(dateKey: string, timeZone: string): number {
    const cacheKey = `${timeZone}:${dateKey}`;
    const cached = dayStartMsByTimezoneAndDate.get(cacheKey);
    if (cached !== undefined) return cached;
    const { year, month, day } = parseDateKey(dateKey);
    const approximateUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    let low = approximateUtcMs - DAY_START_SEARCH_WINDOW_MS;
    let high = approximateUtcMs + DAY_START_SEARCH_WINDOW_MS;

    while (compareDateKeys(getDateKeyInTimeZone(new Date(low), timeZone), dateKey) >= 0) {
        high = low;
        low -= DAY_START_SEARCH_WINDOW_MS;
    }
    while (compareDateKeys(getDateKeyInTimeZone(new Date(high), timeZone), dateKey) < 0) {
        low = high;
        high += DAY_START_SEARCH_WINDOW_MS;
    }

    while ((high - low) > 1) {
        const mid = low + Math.floor((high - low) / 2);
        if (compareDateKeys(getDateKeyInTimeZone(new Date(mid), timeZone), dateKey) < 0) {
            low = mid;
        } else {
            high = mid;
        }
    }

    if (Number.isFinite(high)) {
        if (dayStartMsByTimezoneAndDate.size >= MAX_DAY_START_CACHE_ENTRIES) {
            const oldestKey = dayStartMsByTimezoneAndDate.keys().next().value;
            if (oldestKey !== undefined) dayStartMsByTimezoneAndDate.delete(oldestKey);
        }
        dayStartMsByTimezoneAndDate.set(cacheKey, high);
    }
    return high;
}

export function getStartOfDayInTimeZone(date: Date, timeZone: string): number {
    return getDateKeyStartMs(getDateKeyInTimeZone(date, timeZone), timeZone);
}

export function getWeekStartInTimeZone(date: Date, timeZone: string): number {
    const { year, month, day } = getZonedParts(date, timeZone);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const diffToMonday = (weekday + 6) % 7;
    const weekStartDate = new Date(Date.UTC(year, month - 1, day - diffToMonday));
    return getStartOfDayInTimeZone(weekStartDate, timeZone);
}

export function getMonthStartInTimeZone(date: Date, timeZone: string): number {
    const { year, month } = getZonedParts(date, timeZone);
    const monthStartDate = new Date(Date.UTC(year, month - 1, 1));
    return getStartOfDayInTimeZone(monthStartDate, timeZone);
}

export function formatDateInTimeZone(date: Date, options: Intl.DateTimeFormatOptions, timeZone: string): string {
    return date.toLocaleDateString([], { timeZone, ...options });
}

// The one day-first ("Fri 15 May", "1–15 May") English-pinned date grammar for
// every user-facing Usage-tab date label. Pinned to en-GB so a month-first
// default locale (en-US on CI) can never flip it to "May 15" — one grammar
// across the week chart, solar rows, daily-history axis, hourly-pattern range,
// week range, and day header. Deliberately distinct from `formatDateInTimeZone`
// (default-locale), which the deferred-plan history archive keeps for its own
// locale handling — do not route those callers here.
export function formatDayFirstInTimeZone(
    date: Date,
    options: Intl.DateTimeFormatOptions,
    timeZone: string,
): string {
    return new Intl.DateTimeFormat('en-GB', { timeZone, ...options }).format(date);
}

export function formatTimeInTimeZone(date: Date, options: Intl.DateTimeFormatOptions, timeZone: string): string {
    return date.toLocaleTimeString([], { timeZone, ...options });
}

export function getNextLocalDayStartUtcMs(dayStartUtcMs: number, timeZone: string): number {
    const currentKey = getDateKeyInTimeZone(new Date(dayStartUtcMs), timeZone);
    return getDateKeyStartMs(shiftDateKey(currentKey, 1), timeZone);
}

export function getPreviousLocalDayStartUtcMs(dayStartUtcMs: number, timeZone: string): number {
    const currentKey = getDateKeyInTimeZone(new Date(dayStartUtcMs), timeZone);
    return getDateKeyStartMs(shiftDateKey(currentKey, -1), timeZone);
}

export function buildLocalDayBuckets(params: {
    dayStartUtcMs: number;
    nextDayStartUtcMs: number;
    timeZone: string;
}): { bucketStartUtcMs: number[]; bucketStartLocalLabels: string[] } {
    const { dayStartUtcMs, nextDayStartUtcMs, timeZone } = params;
    const formatter = getHourLabelFormatter(timeZone);
    const bucketCount = Math.max(0, Math.round((nextDayStartUtcMs - dayStartUtcMs) / (60 * 60 * 1000)));
    const bucketStartUtcMs = Array.from({ length: bucketCount }, (_, index) => (
        dayStartUtcMs + index * 60 * 60 * 1000
    ));
    const bucketStartLocalLabels = bucketStartUtcMs.map((ts) => formatter.format(new Date(ts)));
    return { bucketStartUtcMs, bucketStartLocalLabels };
}
