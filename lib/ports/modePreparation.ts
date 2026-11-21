/** The mode action selected by the schedule owner, in Homey's local time. */
export type ModePreparationOccurrence = { mode: string; at: string; atMs: number };

export const MAX_MODE_PREPARATION_LEAD_MS = 6 * 3_600_000;
