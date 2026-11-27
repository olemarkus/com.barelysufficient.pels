/**
 * Feeds PELS's info and higher structured logs into the kept log tail.
 *
 * Selected event streams keep most of an opening burst, with one more slot
 * opening each quarter hour. Overflow checkpoints are written when
 * this boot's count doubles and when the hour ends.
 */
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import {
  LOG_TAIL_HOUR_MS, LOG_TAIL_MAX_LINES_PER_EVENT_HOUR, type LogTailEntry, type LogTailStore,
} from './logTailStore';

/** Pino's info level. Debug lines are left to the opt-in debug topics. */
const PINO_INFO_LEVEL = 30;
/** Lines held before the database opens. A boot normally logs a few dozen. */
const MAX_PENDING_LINES = 500;
const QUARTERS_PER_HOUR = 4;
const QUARTER_HOUR_MS = LOG_TAIL_HOUR_MS / QUARTERS_PER_HOUR;

type LogAdmission = 'regular' | 'paced' | 'below_reserve';

const admissionFor = (event: string, entry: Record<string, unknown>): LogAdmission => {
  switch (event) {
    case 'plan_rebuild_completed':
      return entry.failed === true ? 'paced' : 'below_reserve';
    case 'realtime_capability_drift':
      return entry.pelsEcho === false ? 'paced' : 'below_reserve';
    case 'hard_cap_shortfall_sustained_alert_triggered':
      return 'paced';
    default:
      return 'regular';
  }
};

/** The admission key is the event and its device when the payload names one. */
const classify = (line: string): { key: string; admission: LogAdmission } => {
  try {
    const entry: unknown = JSON.parse(line);
    if (!isUnknownRecord(entry)) return { key: 'unnamed', admission: 'regular' };
    const event = typeof entry.event === 'string' ? entry.event : 'unnamed';
    const device = typeof entry.deviceId === 'string' ? entry.deviceId : entry.chargerId;
    const key = typeof device === 'string' ? `${event}|${device}` : event;
    return { key, admission: admissionFor(event, entry) };
  } catch {
    return { key: 'unparsed', admission: 'regular' };
  }
};

const isPowerOfTwo = (count: number): boolean => Number.isInteger(Math.log2(count));

export class LogTailRecorder {
  private store: LogTailStore | null = null;
  private pending: Array<Omit<LogTailEntry, 'key'>> = [];
  private hourStartMs = -1;
  private linesThisHour = new Map<string, number>();
  private savedOverflow = new Map<string, number>();
  private readonly droppedThisBoot = new Map<string, number>();

  /** One complete JSON log line at a Pino level. The logging destination guards this callback. */
  observe(level: number, line: string): void {
    if (level < PINO_INFO_LEVEL) return;
    const entry = { atMs: Date.now(), level, line };
    if (this.store) this.keep(this.store, entry);
    else if (this.pending.length < MAX_PENDING_LINES) this.pending.push(entry);
  }

  /** Replay startup lines through the same quota as live lines, at their original times. */
  attach(store: LogTailStore): void {
    this.store = store;
    for (const entry of this.pending) this.keep(store, entry);
    this.pending = [];
  }

  detach(): void {
    if (!this.store) return;
    this.flushOverflow(this.store);
    this.hourStartMs = -1;
    this.store = null;
  }

  private keep(store: LogTailStore, entry: Omit<LogTailEntry, 'key'>): void {
    const { key, admission } = classify(entry.line);
    this.rollHour(store, entry.atMs - (entry.atMs % LOG_TAIL_HOUR_MS));

    const kept = this.linesThisHour.get(key) ?? 0;
    const quarter = Math.floor((entry.atMs - this.hourStartMs) / QUARTER_HOUR_MS);
    const laterSlots = admission === 'regular' ? 0 : QUARTERS_PER_HOUR - 1 - quarter;
    const reserve = admission === 'below_reserve' ? 1 : 0;
    const limit = LOG_TAIL_MAX_LINES_PER_EVENT_HOUR - laterSlots - reserve;
    if (kept < limit) {
      this.linesThisHour.set(key, kept + 1);
      store.append({ ...entry, key });
      return;
    }

    const dropped = (this.droppedThisBoot.get(key) ?? 0) + 1;
    this.droppedThisBoot.set(key, dropped);
    if (isPowerOfTwo(dropped)) this.checkpoint(store, key, dropped);
  }

  private rollHour(store: LogTailStore, hourStartMs: number): void {
    if (hourStartMs === this.hourStartMs) return;
    this.flushOverflow(store);
    this.hourStartMs = hourStartMs;
    const saved = store.readHour(hourStartMs);
    this.linesThisHour = saved.kept;
    this.savedOverflow = saved.dropped;
    this.droppedThisBoot.clear();
  }

  private flushOverflow(store: LogTailStore): void {
    for (const [key, dropped] of this.droppedThisBoot) this.checkpoint(store, key, dropped);
  }

  private checkpoint(store: LogTailStore, key: string, dropped: number): void {
    store.recordOverflow(this.hourStartMs, key, (this.savedOverflow.get(key) ?? 0) + dropped);
  }
}
