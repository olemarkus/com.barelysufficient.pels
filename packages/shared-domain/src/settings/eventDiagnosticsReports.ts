/**
 * The `event_diagnostics_reports` setting: whether the owner asked PELS to send
 * the developer a diagnostics report when a specific event happens, such as a
 * charger that could not identify the connected car. Off unless the owner
 * turned it on: like the daily report (`dailyDiagnosticsReport.ts`), Homey files
 * every report as submitted by the user, and only this switch makes that true
 * of a report nobody pressed Send for.
 *
 * The settings UI writes it (Settings → Advanced); the runtime reads it before
 * each event report (`lib/diagnostics/eventReportSchedule.ts`).
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

/** Read policy: on only when explicitly `true`; anything else, absence included, is off. */
export const readEventDiagnosticsReportsEnabled = (raw: unknown): boolean => raw === true;
