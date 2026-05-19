import type Homey from 'homey';
import { buildPriceExport, priceExportFingerprint } from './priceExportBuilder';
import { readPriceStore } from './priceStore';
import type { PriceExportV1 } from '../../packages/contracts/src/priceExport';

type HomeyLike = Homey.App['homey'];
type TriggerCardLike = {
  trigger: (tokens: Record<string, unknown>, state?: Record<string, unknown>) => Promise<unknown>;
};

export const PRICE_LIST_UPDATED_TRIGGER_ID = 'price_list_updated';

export type PriceFlowTagPublisherDeps = {
  homey: HomeyLike;
  requestPriceRefetch: () => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class PriceFlowTagPublisher {
  private lastFingerprint: string | null = null;

  constructor(private deps: PriceFlowTagPublisherDeps) {}

  async publish(reason: string): Promise<void> {
    const exportValue = this.tryBuildExport();
    if (!exportValue) return;
    const fingerprint = priceExportFingerprint(exportValue);
    if (fingerprint === this.lastFingerprint) {
      this.deps.logDebug(`PriceFlowTagPublisher: publish(${reason}) — unchanged fingerprint, skipping`);
      return;
    }
    const json = JSON.stringify(exportValue);
    try {
      await this.fireTrigger(json, reason);
    } catch (error) {
      // Leave lastFingerprint untouched so the next publish retries this payload.
      this.deps.error(`PriceFlowTagPublisher: publish(${reason}) failed — will retry on next update`, error);
      return;
    }
    this.lastFingerprint = fingerprint;
  }

  private tryBuildExport(): PriceExportV1 | null {
    try {
      return this.buildExport();
    } catch (error) {
      this.deps.error('PriceFlowTagPublisher: failed to build price export', error);
      return null;
    }
  }

  private buildExport(): PriceExportV1 {
    const timeZone = this.deps.homey.clock.getTimezone();
    const now = new Date();
    const store = readPriceStore(
      { homey: this.deps.homey, requestRefetch: this.deps.requestPriceRefetch },
      now,
      timeZone,
    );
    return buildPriceExport({ store, now, timeZone });
  }

  private async fireTrigger(json: string, reason: string): Promise<void> {
    const flow = this.deps.homey.flow as { getTriggerCard?: (id: string) => TriggerCardLike };
    if (typeof flow?.getTriggerCard !== 'function') {
      throw new Error('PriceFlowTagPublisher: homey.flow.getTriggerCard unavailable');
    }
    const card = flow.getTriggerCard(PRICE_LIST_UPDATED_TRIGGER_ID);
    await card.trigger({ prices_json: json });
    this.deps.logDebug(`PriceFlowTagPublisher: fired price_list_updated (${reason})`);
  }
}
