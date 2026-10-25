/**
 * Feeds PELS's own log lines into the log tail (`logTailStore.ts`).
 *
 * The root logger exists before the userdata database opens, so lines from the
 * start of a boot wait in memory until a store is attached. Every structured
 * line passes through here; only info and above are kept.
 *
 * A flood is cut per hour at {@link LOG_TAIL_MAX_LINES_PER_EVENT_HOUR} lines of
 * one event for one device, so one device's flood cannot hide another device's
 * lines of the same event. The cut lines are counted in memory and written when
 * the count doubles and when the hour ends: a flood costs a handful of writes,
 * not one per line.
 */
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { LOG_TAIL_MAX_LINES_PER_EVENT_HOUR, type LogTailEntry, type LogTailStore } from './logTailStore';

/** Pino's info level; debug lines are left to the opt-in debug topics. */
const PINO_INFO_LEVEL = 30;
/** Lines held before the database opens: a boot logs a few dozen. */
const MAX_PENDING_LINES = 500;
const HOUR_MS = 60 * 60 * 1000;

/** What the per-hour cap counts: the event, and its device when the line names one. */
const keyOf = (line: string): string => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isUnknownRecord(parsed)) return 'unnamed';
    const event = typeof parsed.event === 'string' ? parsed.event : 'unnamed';
    // Car-link lines name their charger rather than a device.
    const device = typeof parsed.deviceId === 'string' ? parsed.deviceId : parsed.chargerId;
    return typeof device === 'string' ? `${event}|${device}` : event;
  } catch {
    return 'unparsed';
  }
};

const isPowerOfTwo = (count: number): boolean => Number.isInteger(Math.log2(count));

export class LogTailRecorder {
  private store: LogTailStore | null = null;
  private pending: LogTailEntry[] = [];
  private hourStartMs = -1;
  private readonly linesThisHour = new Map<string, number>();
  private readonly droppedThisHour = new Map<string, number>();

  /** One complete JSON log line at a Pino level. Never throws. */
  observe(level: number, line: string): void {
    if (level < PINO_INFO_LEVEL) return;
    const atMs = Date.now();
    const key = keyOf(line);
    this.rollHour(atMs - (atMs % HOUR_MS));
    const kept = this.linesThisHour.get(key) ?? 0;
    if (kept >= LOG_TAIL_MAX_LINES_PER_EVENT_HOUR) {
      const dropped = (this.droppedThisHour.get(key) ?? 0) + 1;
      this.droppedThisHour.set(key, dropped);
      if (isPowerOfTwo(dropped)) this.store?.recordOverflow(this.hourStartMs, key, dropped);
      return;
    }
    this.linesThisHour.set(key, kept + 1);
    const entry = { atMs, level, key, line };
    if (this.store) this.store.append(entry);
    else if (this.pending.length < MAX_PENDING_LINES) this.pending.push(entry);
  }

  /** Hands the waiting lines and counts to the store, and resumes this hour's cap from what it kept. */
  attach(store: LogTailStore): void {
    for (const entry of this.pending) store.append(entry);
    this.pending = [];
    this.store = store;
    if (this.hourStartMs < 0) return;
    for (const [key, lines] of store.countSince(this.hourStartMs)) {
      this.linesThisHour.set(key, Math.max(lines, this.linesThisHour.get(key) ?? 0));
    }
    this.flushOverflow();
  }

  /** Before the database closes; lines after it are not kept. */
  detach(): void {
    this.flushOverflow();
    this.store = null;
  }

  private rollHour(hourStartMs: number): void {
    if (hourStartMs === this.hourStartMs) return;
    this.flushOverflow();
    this.hourStartMs = hourStartMs;
    this.linesThisHour.clear();
    this.droppedThisHour.clear();
  }

  private flushOverflow(): void {
    if (!this.store) return;
    for (const [key, dropped] of this.droppedThisHour) this.store.recordOverflow(this.hourStartMs, key, dropped);
  }
}
