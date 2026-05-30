/**
 * Shared date utility functions for backend and frontend.
 */

const timeZoneOffsetErrorLogged = new Set<string>();
const DAY_START_SEARCH_WINDOW_MS = 72 * 60 * 60 * 1000;

// Intl.DateTimeFormat is the dominant cost of getZonedParts / getTimeZoneOffsetMinutes
// in plan-build (60% of plan-build CPU per a 2026-05-18 CPU profile). The constructor
// is expensive (ICU initialization); the formatter itself is reusable for any date.
// Cache one instance per (timezone, options-shape) since timezones rarely change at
// runtime. Bounded by the number of distinct timezones in use (typically 1-2 per
// session); no eviction needed.
const zonedPartsFormatterByTimezone = new Map<string, Intl.DateTimeFormat>();
const offsetFormatterByTimezone = new Map<string, Intl.DateTimeFormat>();

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

const compareDateKeys = (left: string, right: string): number => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
};

const parseDateKey = (dateKey: string): { year: number; month: number; day: number } => {
    const [year, month, day] = dateKey.split('-').map((value) => Number(value));
    return { year, month, day };
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

export function getHourBucketKey(nowMs: number = Date.now()): string {
    const hourStart = truncateToUtcHour(nowMs);
    return new Date(hourStart).toISOString();
}

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

export function getZonedParts(date: Date, timeZone: string): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
} {
    const parts = getZonedPartsFormatter(timeZone).formatToParts(date);
    // Mutate a single record instead of `reduce` with spread — saves 6 object
    // allocations per call (one per non-literal part).
    const map: Record<string, string> = {};
    for (const part of parts) {
        if (part.type !== 'literal') {
            // eslint-disable-next-line functional/immutable-data -- local scratch; avoids 6 spread allocs
            map[part.type] = part.value;
        }
    }
    const rawHour = Number(map.hour);
    const hour = rawHour === 24 ? 0 : rawHour;
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

/** @public — intentionally retained (was in check-dead-code parked list). */
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

/** @public — intentionally retained (was in check-dead-code parked list). */
export function formatDateInTimeZone(date: Date, options: Intl.DateTimeFormatOptions, timeZone: string): string {
    return date.toLocaleDateString([], { timeZone, ...options });
}

/** @public — intentionally retained (was in check-dead-code parked list). */
export function formatTimeInTimeZone(date: Date, options: Intl.DateTimeFormatOptions, timeZone: string): string {
    return date.toLocaleTimeString([], { timeZone, ...options });
}

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
