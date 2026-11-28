import { getLogger } from '../logging/logger';
import type { FlowPort } from '../ports/homeyRuntime';
import { normalizeError } from '../utils/errorUtils';
import { PriceLevel } from './priceLevels';
import type { PriceLevelSchedule } from './priceLevelUtils';

const logger = getLogger('price/levelFlow');
const MINIMUM_BOUNDARY_DELAY_MS = 100;
const READ_RETRY_DELAY_MS = 30_000;
const MAX_TIMEOUT_DELAY_MS = 2 ** 31 - 1;

/** Owns the Main home's price-change Flow, independently of capacity decisions. */
export class PriceLevelFlowPublisher {
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastLevel = PriceLevel.UNKNOWN;

  constructor(
    private readonly flow: Pick<FlowPort, 'getTriggerCard'>,
    private readonly readSchedule: (nowMs: number) => PriceLevelSchedule,
  ) {}

  start(): void {
    this.started = true;
    this.update();
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  update(): void {
    if (!this.started) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      const { level, nextBoundaryMs } = this.readSchedule(Date.now());
      if (nextBoundaryMs !== null) {
        const delayMs = Math.max(MINIMUM_BOUNDARY_DELAY_MS, nextBoundaryMs - Date.now());
        this.arm(Math.min(delayMs, MAX_TIMEOUT_DELAY_MS));
      }
      if (level === this.lastLevel) return;
      this.lastLevel = level;
      void this.publish(level);
    } catch (error) {
      logger.warn({ event: 'price_level_read_failed', err: normalizeError(error) });
      this.arm(READ_RETRY_DELAY_MS);
    }
  }

  private arm(delayMs: number): void {
    this.timer = setTimeout(() => this.update(), delayMs);
  }

  private async publish(level: PriceLevel): Promise<void> {
    try {
      const card = this.flow.getTriggerCard('price_level_changed');
      await card.trigger({ level }, { priceLevel: level });
    } catch (error) {
      logger.error({ event: 'price_level_trigger_failed', err: normalizeError(error) });
    }
  }
}
