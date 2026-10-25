/**
 * Device-level occurrences PELS keeps for problem reports: what it observed and
 * decided about a device, in the shape of the structured-log event it also
 * emits. Homey attaches only the last 100 stdout lines to a report, so an event
 * hours older than the report is gone from the log; this keeps it.
 *
 * Transport (`lib/device/`) records through this port and diagnostics
 * (`lib/diagnostics/deviceEventStore.ts`) persists and reads it. Neither layer
 * may import the other, so the shapes live here.
 */
export type DeviceJournalEvent = {
  readonly component: string;
  readonly event: string;
  readonly [field: string]: unknown;
};

export type DeviceJournal = {
  /**
   * Keep `event` for every device it is about. Never throws: a journal that
   * cannot write must not interrupt the decision that produced the event.
   */
  record(deviceIds: readonly string[], event: DeviceJournalEvent): void;
};
