/**
 * Reports on specific events the owner turned on (Settings → Advanced), such as
 * a charger that could not identify the connected car.
 *
 * Checked every few minutes ({@link EVENT_REPORT_CHECK_INTERVAL_MS}) from a
 * while after start ({@link EVENT_REPORT_FIRST_CHECK_DELAY_MS}), over the device events kept in the
 * last {@link EVENT_REPORT_LOOKBACK_MS} (`deviceEventStore.ts`). A report waits
 * those minutes on purpose: it then carries what followed the event too.
 * Which events send a report, what it is about and what it says lives in
 * {@link REPORTED_EVENTS}; add an event there.
 *
 * One report per event per device a day, and at most
 * {@link EVENT_REPORTS_MAX_PER_DAY} attempts a day in all: one that could not
 * go out for good, such as on an install that cannot send, counts too. What was sent lives in the
 * userdata database and is written before sending, so a restart, or a charger
 * that keeps failing, never sends the same report twice. One that could not go
 * out is tried again on a later check while its event is still in the lookback.
 */
import type {
  SupportReportDeviceEvent, SupportReportErrorCode, SupportReportRequest, SupportReportResponse,
} from '../../packages/contracts/src/supportReport';
import { readEventDiagnosticsReportsEnabled } from '../../packages/shared-domain/src/settings/eventDiagnosticsReports';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { HomeMembershipPort } from '../home/membership';
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { EVENT_DIAGNOSTICS_REPORTS } from '../utils/settingsKeys';
import type { DeviceEventStore } from './deviceEventStore';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const EVENT_REPORT_CHECK_INTERVAL_MS = 5 * MINUTE_MS;
/**
 * Like the daily report, a while after start so a report never captures a
 * half-started app, and two minutes off its hourly check, so the two reports
 * are not captured together and the second refused for the minute between sends.
 */
export const EVENT_REPORT_FIRST_CHECK_DELAY_MS = 17 * MINUTE_MS;
/** Covers the first check after start and several later ones, so a report Homey refused is tried again. */
export const EVENT_REPORT_LOOKBACK_MS = 30 * MINUTE_MS;
export const EVENT_REPORTS_MAX_PER_DAY = 6;
const logger = getLogger('diagnostics/event-report');

/** One report an event asks for: about which device, when it happened, and what to say. */
type EventReport = {
  /** One report per this a day: the event and its device. */
  key: string;
  event: string;
  deviceId: string;
  occurredAtMs: number;
  problem: string;
};

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * The events that send a report, each turning a kept event into the report
 * it asks for; an event without the fields its report needs asks for none.
 */
export const REPORTED_EVENTS: ReadonlyMap<string, (event: SupportReportDeviceEvent) => EventReport[]> = new Map([
  // A charger's window closed with no car identified (`notes/ev-car-link/README.md`).
  ['ev_car_link_unmatched', (event: SupportReportDeviceEvent): EventReport[] => {
    const chargerId = text(event.details.chargerId);
    if (chargerId === undefined) return [];
    const { connection } = event.details;
    const pluggedInAtMs = isUnknownRecord(connection) && typeof connection.atMs === 'number'
      ? connection.atMs : event.atMs;
    const reason = text(event.details.reason);
    return [{
      key: `${event.event}|${chargerId}`,
      event: event.event,
      deviceId: chargerId,
      occurredAtMs: pluggedInAtMs,
      problem: `Sent because ${text(event.details.chargerName) ?? chargerId} was plugged in and PELS could not `
        + `identify the connected car${reason === undefined ? '' : ` (${reason})`}. `
        + 'The owner turned on reports on specific events.',
    }];
  }],
]);

/** A report that did not go out, and may on a later check. */
const TRIED_AGAIN: ReadonlySet<SupportReportErrorCode> = new Set<SupportReportErrorCode>([
  'report_busy', 'capture_failed', 'sender_unavailable',
]);

export type EventReportStateStore = {
  /** Whether this event's report for this device went out, or may have, in the last day. */
  hasSent(key: string): boolean;
  countSentSince(fromMs: number): number;
  markSent(key: string, atMs: number): void;
  unmarkSent(key: string): void;
  forgetBefore(beforeMs: number): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_report_sent (
  key TEXT PRIMARY KEY,
  sent_at_ms INTEGER NOT NULL
);
`;

export const createEventReportStateStore = (db: UserdataDatabase): EventReportStateStore => {
  db.exec(SCHEMA);
  const read = db.prepare('SELECT 1 FROM event_report_sent WHERE key = ?');
  const count = db.prepare('SELECT COUNT(*) AS sent FROM event_report_sent WHERE sent_at_ms >= ?');
  const write = db.prepare('INSERT INTO event_report_sent (key, sent_at_ms) VALUES (?, ?) '
    + 'ON CONFLICT (key) DO UPDATE SET sent_at_ms = excluded.sent_at_ms');
  const remove = db.prepare('DELETE FROM event_report_sent WHERE key = ?');
  const expire = db.prepare('DELETE FROM event_report_sent WHERE sent_at_ms < ?');
  return {
    hasSent: (key) => read.get(key) !== undefined,
    countSentSince: (fromMs) => {
      const value = count.get(fromMs)?.sent;
      return typeof value === 'number' ? value : 0;
    },
    markSent: (key, atMs) => { write.run(key, atMs); },
    unmarkSent: (key) => { remove.run(key); },
    forgetBefore: (beforeMs) => { expire.run(beforeMs); },
  };
};

const outcomeOf = (response: SupportReportResponse): { triedAgain: boolean; outcome: string } => {
  if (response.ok) {
    const { state } = response.report.submission;
    return { triedAgain: state === 'failed', outcome: state };
  }
  return { triedAgain: TRIED_AGAIN.has(response.code), outcome: response.code };
};

export class EventReportSchedule {
  private running = false;

  constructor(
    private readonly settings: SettingsPort,
    private readonly state: EventReportStateStore,
    private readonly events: Pick<DeviceEventStore, 'read'>,
    private readonly membership: Pick<HomeMembershipPort, 'getHomeIdForDevice'>,
    private readonly reports: {
      sendOnEvent(request: SupportReportRequest, stillWanted: () => boolean): Promise<SupportReportResponse>;
    },
  ) {}

  private isOn(): boolean {
    return readEventDiagnosticsReportsEnabled(this.settings.get(EVENT_DIAGNOSTICS_REPORTS));
  }

  /**
   * Send the report for the first kept event in the lookback that asks for one
   * not sent today, when the owner turned these reports on. One per check: the
   * report service sends one a minute. Never throws.
   */
  async check(nowMs: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.isOn()) return;
      this.state.forgetBefore(nowMs - DAY_MS);
      if (this.state.countSentSince(nowMs - DAY_MS) >= EVENT_REPORTS_MAX_PER_DAY) return;
      const due = this.events.read('all', nowMs - EVENT_REPORT_LOOKBACK_MS, nowMs)
        .flatMap((event) => REPORTED_EVENTS.get(event.event)?.(event) ?? [])
        .find((report) => !this.state.hasSent(report.key));
      if (!due) return;
      const request: SupportReportRequest = {
        subject: { kind: 'device', homeId: this.membership.getHomeIdForDevice(due.deviceId), deviceId: due.deviceId },
        problem: due.problem,
        expected: '',
        occurredAtMs: due.occurredAtMs,
        historyWindow: 'incident',
      };
      this.state.markSent(due.key, nowMs);
      const { triedAgain, outcome } = outcomeOf(await this.reports.sendOnEvent(request, () => this.isOn()));
      if (triedAgain) this.state.unmarkSent(due.key);
      logger.info({ event: 'event_report_attempted', reportedEvent: due.event, deviceId: due.deviceId, outcome });
    } catch (error) {
      logger.warn({
        event: 'event_report_check_failed', reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
