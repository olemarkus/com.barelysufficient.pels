// TWIN FILE — the browser-safe counterpart of `lib/utils/dateUtils.ts`
// (runtime). The settings UI consumes this copy because
// `.dependency-cruiser.cjs`'s `no-settings-ui-to-runtime` rule (error) forbids
// settings-ui → `lib/**`, so the duplication is structural. The copies are kept
// in step BY HAND — no sync script, no CI check — and have already drifted (the
// runtime copy caches its `Intl.DateTimeFormat` instances; this one carries
// `formatDayFirstInTimeZone`). An export with no importer in one copy carries
// `@public` there so knip does not report it; do not delete it from one side.
const timeZoneOffsetErrorLogged = new Set<string>();
const DAY_START_SEARCH_WINDOW_MS = 72 * 60 * 60 * 1000;

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

export function truncateToUtcHour(timestamp: number): number {
    const date = new Date(timestamp);
    return Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        0,
        0,
        0,
    );
}

/** @public — no importer in this copy; see the twin note at the top of the file. */
export function getHourBucketKey(nowMs: number = Date.now()): string {
    const hourStart = truncateToUtcHour(nowMs);
    return new Date(hourStart).toISOString();
}

export function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
    let primaryError: unknown;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            timeZoneName: 'shortOffset',
            hour: '2-digit',
        }).formatToParts(date);
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
            const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            console.warn(
                `getTimeZoneOffsetMinutes: failed to compute offset for ${timeZone}: `
                + `${primaryMessage}; fallback failed: ${fallbackMessage}`,
            );
            timeZoneOffsetErrorLogged.add(timeZone);
        }
        return 0;
    }
}

/**
 * Duplicated from `lib/utils/dateUtils.ts`: shared-domain is browser-safe and
 * must not import from `lib/**`, so the two copies are kept textually identical
 * rather than consolidated. Only `Hour` is needed here; `HourProfile` and its
 * constructors live in the runtime copy until a shared-domain caller wants them.
 *
 * An hour of the day. The literal union is what makes an hour-indexed profile
 * checkable: `HourProfile[Hour]` is `number`, while `number[]` indexed by a
 * plain `number` is `number | undefined` under `noUncheckedIndexedAccess`.
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
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        hourCycle: 'h23',
    }).formatToParts(date);
    const map = parts.reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') {
            return { ...acc, [part.type]: part.value };
        }
        return acc;
    }, {});
    const rawHour = Number(map.hour);
    // `hourCycle: 'h23'` yields 00-23, and the 24 -> 0 wrap covers the one
    // legacy formatter that reports midnight as 24. The guard is what lets the
    // hour leave here typed `Hour`, so every profile read downstream is checked.
    const wrapped = rawHour === 24 ? 0 : rawHour;
    if (!isHour(wrapped)) {
        // Unreachable with `hourCycle: 'h23'`, which always emits an hour part.
        // Refuse rather than name midnight: this value keys the tracker's
        // capacity buckets, so guessing would post energy to a real hour.
        throw new RangeError(`getZonedParts produced a non-hour: ${String(map.hour)}`);
    }
    const hour: Hour = wrapped;
    return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour,
        minute: Number(map.minute),
        second: Number(map.second),
    };
}

export function getDateKeyInTimeZone(date: Date, timeZone: string): string {
    const { year, month, day } = getZonedParts(date, timeZone);
    const yyyy = year.toString().padStart(4, '0');
    const mm = month.toString().padStart(2, '0');
    const dd = day.toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

export function shiftDateKey(dateKey: string, dayDelta: number): string {
    const { year, month, day } = parseDateKey(dateKey);
    return new Date(Date.UTC(year, month - 1, day + dayDelta, 0, 0, 0, 0)).toISOString().slice(0, 10);
}

export function getDateKeyStartMs(dateKey: string, timeZone: string): number {
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

/** @public — no importer in this copy; see the twin note at the top of the file. */
export function getHourStartInTimeZone(date: Date, timeZone: string): number {
    const { year, month, day, hour } = getZonedParts(date, timeZone);
    const utcHour = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
    // Use the offset at the actual instant so repeated fall-back hours resolve to the active occurrence.
    const offsetMinutes = getTimeZoneOffsetMinutes(date, timeZone);
    return utcHour - offsetMinutes * 60 * 1000;
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
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const bucketCount = Math.max(0, Math.round((nextDayStartUtcMs - dayStartUtcMs) / (60 * 60 * 1000)));
    const bucketStartUtcMs = Array.from({ length: bucketCount }, (_, index) => (
        dayStartUtcMs + index * 60 * 60 * 1000
    ));
    const bucketStartLocalLabels = bucketStartUtcMs.map((ts) => formatter.format(new Date(ts)));
    return { bucketStartUtcMs, bucketStartLocalLabels };
}
