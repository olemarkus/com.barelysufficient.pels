import type { AppContext } from '../../lib/app/appContext';
import {
  createDailyReportStateStore, DailyReportSchedule,
} from '../../lib/diagnostics/dailyReportSchedule';
import { LogTailRecorder } from '../../lib/diagnostics/logTailRecorder';
import { createLogTailStore } from '../../lib/diagnostics/logTailStore';
import type { SupportReportService } from '../../lib/diagnostics/supportReportService';
import { createHomeyDestination, type HomeyLogCallbacks } from '../../lib/logging/homeyDestination';
import { createRootLogger, setRootLogger, type Logger as PinoLogger } from '../../lib/logging/logger';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';

const HOUR_MS = 60 * 60 * 1000;
/** The first check waits for the app to settle, so a report never captures a half-started app. */
const FIRST_CHECK_DELAY_MS = 15 * 60 * 1000;

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
  timers.registerTimeout('dailyReportFirstCheck', setTimeout(check, FIRST_CHECK_DELAY_MS));
  timers.registerInterval('dailyReportCheck', setInterval(check, HOUR_MS));
};
