/**
 * The daily diagnostics report the owner turned on (Settings → Advanced).
 *
 * Checked every hour ({@link DAILY_REPORT_CHECK_INTERVAL_MS}), first a while after
 * start ({@link DAILY_REPORT_FIRST_CHECK_DELAY_MS}) so a report never captures a
 * half-started app. When the switch is on and the next attempt is due, PELS
 * sends a report about the whole app over the last day (`SupportReportService
 * .sendDaily`). About once a day: every 19 hours
 * ({@link DAILY_REPORT_INTERVAL_MS}), so the time of day moves around the
 * clock. When the next attempt is due lives in the userdata database, so a
 * restart or an update neither sends twice nor skips one.
 *
 * A report that went out, or whose delivery is uncertain, waits the full
 * interval: sending again soon could deliver it twice. One that could not go
 * out tries again in a few hours. An install that cannot send at all (anything
 * but an App Store install) waits the full interval too, so it never checks
 * more than about daily.
 */
import type { SupportReportResponse } from '../../packages/contracts/src/supportReport';
import { readDailyDiagnosticsReportEnabled } from '../../packages/shared-domain/src/settings/dailyDiagnosticsReport';
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { UserdataDatabase } from '../store/userdataDatabase';
import { DAILY_DIAGNOSTICS_REPORT } from '../utils/settingsKeys';

const HOUR_MS = 60 * 60 * 1000;
export const DAILY_REPORT_CHECK_INTERVAL_MS = HOUR_MS;
export const DAILY_REPORT_FIRST_CHECK_DELAY_MS = 15 * 60 * 1000;
/**
 * 19 hours, less half the hourly check: a report sent on one check is due
 * again on the check 19 hours later, never one either side of it. 19 shares no
 * factor with 24, so each report goes out 5 hours earlier in the day than the
 * one before, and 24 of them cover every hour of the day: a home is seen at
 * night, at the morning and evening peaks, and in between, not always at the
 * hour it happened to start.
 */
export const DAILY_REPORT_INTERVAL_MS = 18.5 * HOUR_MS;
export const DAILY_REPORT_RETRY_MS = 3 * HOUR_MS;
/**
 * The furthest ahead a due time is ever written: a day covers the interval and
 * the 23.5 hours earlier versions wrote, so an update right after a
 * report never mistakes that report's due time for one written while the clock
 * ran ahead, and sends again at once.
 */
const DAILY_REPORT_MAX_AHEAD_MS = 24 * HOUR_MS;
const logger = getLogger('diagnostics/daily-report');

export type DailyReportStateStore = {
  /** When the next report is due; absent before the first attempt. */
  readNextAttemptAtMs(): number | undefined;
  writeNextAttemptAtMs(atMs: number): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_report_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_attempt_at_ms INTEGER NOT NULL
);
`;

export const createDailyReportStateStore = (db: UserdataDatabase): DailyReportStateStore => {
  db.exec(SCHEMA);
  const read = db.prepare('SELECT next_attempt_at_ms FROM daily_report_state WHERE id = 1');
  const write = db.prepare('INSERT INTO daily_report_state (id, next_attempt_at_ms) VALUES (1, ?) '
    + 'ON CONFLICT (id) DO UPDATE SET next_attempt_at_ms = excluded.next_attempt_at_ms');
  return {
    readNextAttemptAtMs: () => {
      const value = read.get()?.next_attempt_at_ms;
      return typeof value === 'number' ? value : undefined;
    },
    writeNextAttemptAtMs: (atMs) => { write.run(atMs); },
  };
};

/** How long after this outcome the next attempt waits, and what to call the outcome. */
const resolveNextAttempt = (response: SupportReportResponse): { delayMs: number; outcome: string } => {
  if (response.ok) {
    const { state } = response.report.submission;
    return { delayMs: state === 'failed' ? DAILY_REPORT_RETRY_MS : DAILY_REPORT_INTERVAL_MS, outcome: state };
  }
  // `consent_required`: the owner turned the switch off while the report was prepared.
  const waitsADay = response.code === 'app_store_required' || response.code === 'report_too_large'
    || response.code === 'consent_required';
  return { delayMs: waitsADay ? DAILY_REPORT_INTERVAL_MS : DAILY_REPORT_RETRY_MS, outcome: response.code };
};

export class DailyReportSchedule {
  private running = false;

  constructor(
    private readonly settings: SettingsPort,
    private readonly state: DailyReportStateStore,
    private readonly reports: { sendDaily(stillWanted: () => boolean): Promise<SupportReportResponse> },
  ) {}

  private isOn(): boolean {
    return readDailyDiagnosticsReportEnabled(this.settings.get(DAILY_DIAGNOSTICS_REPORT));
  }

  /**
   * Send the daily report when the owner turned it on and it is due. The next
   * due time is written before sending, as if the report goes out: a restart
   * mid-send, or a write that fails afterwards, must never send it again within
   * the day. A write that fails before sending sends nothing. Never throws.
   */
  async check(nowMs: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.isOn()) return;
      const nextAttemptAtMs = this.state.readNextAttemptAtMs();
      // Never more than a day ahead, unless it was written while the clock ran
      // ahead; then waiting for it could hold the report back for days.
      if (nextAttemptAtMs !== undefined && nowMs < nextAttemptAtMs
        && nextAttemptAtMs - nowMs <= DAILY_REPORT_MAX_AHEAD_MS) return;
      this.state.writeNextAttemptAtMs(nowMs + DAILY_REPORT_INTERVAL_MS);
      const { delayMs, outcome } = resolveNextAttempt(await this.reports.sendDaily(() => this.isOn()));
      if (delayMs !== DAILY_REPORT_INTERVAL_MS) this.state.writeNextAttemptAtMs(nowMs + delayMs);
      logger.info({ event: 'daily_report_attempted', outcome, nextAttemptAtMs: nowMs + delayMs });
    } catch (error) {
      logger.warn({
        event: 'daily_report_check_failed', reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }
}
