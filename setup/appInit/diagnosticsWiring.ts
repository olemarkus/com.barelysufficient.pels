import type { AppContext } from '../../lib/app/appContext';
import {
  createDailyReportStateStore, DAILY_REPORT_CHECK_INTERVAL_MS, DAILY_REPORT_FIRST_CHECK_DELAY_MS, DailyReportSchedule,
} from '../../lib/diagnostics/dailyReportSchedule';
import { createDeviceEventStore } from '../../lib/diagnostics/deviceEventStore';
import {
  createEventReportStateStore, EVENT_REPORT_CHECK_INTERVAL_MS, EVENT_REPORT_FIRST_CHECK_DELAY_MS, EventReportSchedule,
} from '../../lib/diagnostics/eventReportSchedule';
import { LogTailRecorder } from '../../lib/diagnostics/logTailRecorder';
import { createLogTailStore } from '../../lib/diagnostics/logTailStore';
import type { SupportReportService } from '../../lib/diagnostics/supportReportService';
import { createHomeyDestination, type HomeyLogCallbacks } from '../../lib/logging/homeyDestination';
import { createRootLogger, setRootLogger, type Logger as PinoLogger } from '../../lib/logging/logger';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';
import { requireHomeMembership } from './contextGuards';

/**
 * The process-wide structured logger, writing to Homey's log and to the log
 * PELS keeps for problem reports. The kept log waits in memory until
 * {@link attachLogTail} gives it the database.
 */
export const installStructuredLogger = (
  callbacks: HomeyLogCallbacks,
): { logger: PinoLogger; logTail: LogTailRecorder } => {
  const logTail = new LogTailRecorder();
  const logger = createRootLogger(
    createHomeyDestination(callbacks, (level, line) => logTail.observe(level, line)),
  );
  setRootLogger(logger);
  return { logger, logTail };
};

export const attachLogTail = (logTail: LogTailRecorder, ctx: Pick<AppContext, 'getUserdataDatabase'>): void => {
  logTail.attach(createLogTailStore(ctx.getUserdataDatabase()));
};

/** Checks hourly whether the daily report the owner turned on is due (`dailyReportSchedule.ts`). */
export const startDailyReport = (
  ctx: Pick<AppContext, 'homey' | 'getUserdataDatabase'>,
  reports: Pick<SupportReportService, 'sendDaily'>,
  timers: TimerRegistry,
): void => {
  const schedule = new DailyReportSchedule(
    ctx.homey.settings, createDailyReportStateStore(ctx.getUserdataDatabase()), reports,
  );
  const check = (): void => { void schedule.check(Date.now()); };
  timers.registerTimeout('dailyReportFirstCheck', setTimeout(check, DAILY_REPORT_FIRST_CHECK_DELAY_MS));
  timers.registerInterval('dailyReportCheck', setInterval(check, DAILY_REPORT_CHECK_INTERVAL_MS));
};

/** Checks every few minutes for an event the owner asked to be told about (`eventReportSchedule.ts`). */
export const startEventReports = (
  ctx: Pick<AppContext, 'homey' | 'getUserdataDatabase' | 'homeMembership'>,
  reports: Pick<SupportReportService, 'sendOnEvent'>,
  timers: TimerRegistry,
): void => {
  const db = ctx.getUserdataDatabase();
  const schedule = new EventReportSchedule(
    ctx.homey.settings, createEventReportStateStore(db), createDeviceEventStore(db),
    // Read per check: membership is cleared at shutdown, and a check then fails into its warning.
    { getHomeIdForDevice: (deviceId) => requireHomeMembership(ctx).getHomeIdForDevice(deviceId) },
    reports,
  );
  const check = (): void => { void schedule.check(Date.now()); };
  // The checks start with the first one: an interval shorter than the delay would otherwise run first.
  timers.registerTimeout('eventReportFirstCheck', setTimeout(() => {
    check();
    timers.registerInterval('eventReportCheck', setInterval(check, EVENT_REPORT_CHECK_INTERVAL_MS));
  }, EVENT_REPORT_FIRST_CHECK_DELAY_MS));
};
