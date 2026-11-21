/** The mode action selected by the schedule owner, in Homey's local time. */
export type ModePreparationOccurrence = { scheduleId: string; mode: string; at: string; atMs: number };

/** A failed read can continue an accepted occurrence for devices already preparing. */
export type ModePreparationRead = ModePreparationOccurrence | 'unavailable' | undefined;

/** A pending occurrence may still run within this much time after its scheduled instant. */
export const SCHEDULE_CATCH_UP_MS = 120_000;

export const MAX_MODE_PREPARATION_LEAD_MS = 6 * 3_600_000;
