/**
 * The installed Flow action cards (`manager/flow/flowcardaction`) as the device
 * transport last read them: one read shared by every owner that runs app actions
 * (home batteries, charger current, charger phase). The list holds every action
 * card of every installed app, so an owner resolves its runs against the last
 * read rather than reading it again per run: a charging current or a battery
 * setpoint can change every few seconds.
 *
 * - A read stands for `CARD_INVENTORY_MAX_AGE_MS`. A failed read is retried
 *   `CARD_INVENTORY_RETRY_MS` later, keeping the cards last read: they were
 *   installed then.
 * - A run whose card is missing from the standing read reads it again once,
 *   unless that read started within `CARD_INVENTORY_RETRY_MS`: an app just
 *   installed or updated registers its cards after PELS last looked.
 * - A failed run brings the next read forward to `CARD_INVENTORY_RETRY_MS`.
 *
 * Owned by the transport instance (`createHomeyActionOwners`).
 */
import { normalizeError } from '../utils/errorUtils';
import type { Logger } from '../utils/types';
import { FLOW_ACTION_CARDS_API_PATH, readFlowActionCardIds, type FlowActionCardIds } from './flowActionCards';
import { getRawFromHomeyApi } from './transport/managerHomeyApi';

/** How long an inventory read stands before it is read again. */
export const CARD_INVENTORY_MAX_AGE_MS = 60 * 60_000;
/** How soon after a failed inventory read, or a failed run, the inventory is read again. */
export const CARD_INVENTORY_RETRY_MS = 60_000;

/** A read that succeeded: its cards, and when the read that returned them started. */
export type FlowActionCardRead = { cards: FlowActionCardIds; startedAtMs: number };

type InventoryState =
  | { kind: 'unread'; retryAtMs: number }
  | { kind: 'read'; read: FlowActionCardRead; refreshAtMs: number };

export class FlowActionCardInventory {
  private state: InventoryState = { kind: 'unread', retryAtMs: 0 };
  private reading: Promise<void> | undefined;
  /** Why the last read failed, thrown to a run that has no read to fall back on. */
  private lastFailure: unknown = new Error('The Flow action cards have not been read yet.');

  constructor(private readonly logger: Pick<Logger, 'structuredLog'>) {}

  /** The last read that succeeded, or `undefined` before any did. */
  last(): FlowActionCardRead | undefined {
    return this.state.kind === 'read' ? this.state.read : undefined;
  }

  /** Whether the standing read has aged out, or a failed read is due again. */
  isDue(nowMs: number): boolean {
    return this.state.kind === 'read' ? nowMs >= this.state.refreshAtMs : nowMs >= this.state.retryAtMs;
  }

  /** Read the inventory now, joining a read already running. Never rejects. */
  refresh(): Promise<void> {
    const startedAtMs = Date.now();
    this.reading ??= getRawFromHomeyApi(FLOW_ACTION_CARDS_API_PATH).then(
      (raw) => {
        this.state = {
          kind: 'read',
          read: { cards: readFlowActionCardIds(raw), startedAtMs },
          refreshAtMs: Date.now() + CARD_INVENTORY_MAX_AGE_MS,
        };
      },
    ).catch((error: unknown) => {
      this.lastFailure = error;
      if (this.state.kind === 'read') this.state = { ...this.state, refreshAtMs: retryAt() };
      else this.state = { kind: 'unread', retryAtMs: retryAt() };
      this.logger.structuredLog.warn({ event: 'flow_action_cards_read_failed', err: normalizeError(error) });
    }).finally(() => { this.reading = undefined; });
    return this.reading;
  }

  /** Bring the next read forward to `CARD_INVENTORY_RETRY_MS` from now, never put it back. */
  retrySoon(): void {
    if (this.state.kind !== 'read') return;
    this.state = { ...this.state, refreshAtMs: Math.min(this.state.refreshAtMs, retryAt()) };
  }

  /**
   * What `pick` resolves from the cards for a run now: against the standing
   * read, read first when none stands or it is due, and read once more when
   * `pick` finds nothing in a read older than `CARD_INVENTORY_RETRY_MS`.
   * `undefined` when the cards still lack it. Throws the last read failure
   * when no read has succeeded and none can be made now.
   */
  async resolve<T>(pick: (cards: FlowActionCardIds) => T | undefined): Promise<T | undefined> {
    if (this.isDue(Date.now())) await this.refresh();
    const standing = this.last();
    if (standing === undefined) throw this.lastFailure;
    const picked = pick(standing.cards);
    if (picked !== undefined || Date.now() - standing.startedAtMs < CARD_INVENTORY_RETRY_MS) return picked;
    await this.refresh();
    const reread = this.last();
    return reread === undefined || reread === standing ? undefined : pick(reread.cards);
  }
}

const retryAt = (): number => Date.now() + CARD_INVENTORY_RETRY_MS;
