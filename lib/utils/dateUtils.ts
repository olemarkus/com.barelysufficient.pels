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
