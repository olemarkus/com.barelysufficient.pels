/**
 * Feeds PELS's own log lines into the log tail (`logTailStore.ts`).
 *
 * The root logger exists before the userdata database opens, so lines from the
 * start of a boot wait in memory until a store is attached. Every structured
 * line passes through here; only info and above are kept.
 */
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { LOG_TAIL_MAX_LINES_PER_EVENT_HOUR, type LogTailEntry, type LogTailStore } from './logTailStore';

/** Pino's info level; debug lines are left to the opt-in debug topics. */
const PINO_INFO_LEVEL = 30;
/** Lines held before the database opens: a boot logs a few dozen. */
const MAX_PENDING_LINES = 500;
const HOUR_MS = 60 * 60 * 1000;

const eventOf = (line: string): string => {
  try {
    const parsed: unknown = JSON.parse(line);
    return isUnknownRecord(parsed) && typeof parsed.event === 'string' ? parsed.event : 'unnamed';
  } catch {
    return 'unparsed';
  }
};

export class LogTailRecorder {
  private store: LogTailStore | null = null;
  private pending: LogTailEntry[] = [];
  private hourStartMs = -1;
  private readonly linesThisHour = new Map<string, number>();

  /** One complete JSON log line at a Pino level. Never throws. */
  observe(level: number, line: string): void {
    if (level < PINO_INFO_LEVEL) return;
    const atMs = Date.now();
    const event = eventOf(line);
    const hourStartMs = atMs - (atMs % HOUR_MS);
    if (hourStartMs !== this.hourStartMs) {
      this.hourStartMs = hourStartMs;
      this.linesThisHour.clear();
    }
    const kept = this.linesThisHour.get(event) ?? 0;
    if (kept >= LOG_TAIL_MAX_LINES_PER_EVENT_HOUR) {
      this.store?.countOverflow(hourStartMs, event);
      return;
    }
    this.linesThisHour.set(event, kept + 1);
    const entry = { atMs, level, event, line };
    if (this.store) this.store.append(entry);
    else if (this.pending.length < MAX_PENDING_LINES) this.pending.push(entry);
  }

  attach(store: LogTailStore): void {
    for (const entry of this.pending) store.append(entry);
    this.pending = [];
    this.store = store;
  }

  /** Before the database closes; lines after it are not kept. */
  detach(): void {
    this.store = null;
  }
}
