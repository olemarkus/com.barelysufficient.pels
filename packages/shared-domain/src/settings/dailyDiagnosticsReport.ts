/**
 * The `daily_diagnostics_report` setting: whether the owner asked PELS to send
 * the developer a diagnostics report once a day. Off unless the owner turned it
 * on: Homey files every report as submitted by the user, and only this switch
 * makes that true of a report nobody pressed Send for (owner, 2026-10-25).
 *
 * The settings UI writes it (Settings → Advanced); the runtime reads it before
 * each daily send (`lib/diagnostics/dailyReportSchedule.ts`).
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

/** Read policy: on only when explicitly `true`; anything else, absence included, is off. */
export const readDailyDiagnosticsReportEnabled = (raw: unknown): boolean => raw === true;
