/**
 * Shared date utility functions for backend and frontend.
 */

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
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            timeZoneName: 'shortOffset',
            hour: '2-digit',
        }).formatToParts(date);
        const tzName = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
        const match = tzName.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
        if (!match) return 0;
        const hours = Number(match[1]);
        const minutes = match[2] ? Number(match[2]) : 0;
        return hours * 60 + Math.sign(hours) * minutes;
    } catch {
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
    return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function getDateKeyStartMs(dateKey: string, timeZone: string): number {
    const [year, month, day] = dateKey.split('-').map((value) => Number(value));
    const utcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0);
    const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcMidnight), timeZone);
    return utcMidnight - offsetMinutes * 60 * 1000;
}

export function getLocalDayStartUtcMs(nowMs: number, timeZone: string): number {
    const dateKey = getDateKeyInTimeZone(new Date(nowMs), timeZone);
    return getDateKeyStartMs(dateKey, timeZone);
}

export function getNextLocalDayStartUtcMs(dayStartUtcMs: number, timeZone: string): number {
    const nextCandidate = new Date(dayStartUtcMs + 26 * 60 * 60 * 1000);
    const nextKey = getDateKeyInTimeZone(nextCandidate, timeZone);
    return getDateKeyStartMs(nextKey, timeZone);
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
