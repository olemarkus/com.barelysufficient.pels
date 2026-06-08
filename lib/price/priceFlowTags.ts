import type { ClockPort, FlowPort, FlowToken } from '../ports/homeyRuntime';
import { buildPriceExport, priceExportFingerprint } from './priceExportBuilder';
import type { CombinedPricesReader } from './combinedPricesReader';
import { normalizeError } from '../utils/errorUtils';
import type { PriceExportV1 } from '../../packages/contracts/src/priceExport';
import type { StructuredDebugEmitter } from '../logging/logger';
import { getLogger } from '../logging/logger';

const moduleLogger = getLogger('price/flowTags');

export const PRICE_FLOW_TAG_ID = 'pels_prices_json';
export const PRICE_LIST_UPDATED_TRIGGER_ID = 'price_list_updated';

export type PriceFlowTagPublisherDeps = {
  homey: { clock: ClockPort; flow: FlowPort };
  combinedPricesReader: CombinedPricesReader;
  log: (...args: unknown[]) => void;
  debugStructured: StructuredDebugEmitter;
};

export class PriceFlowTagPublisher {
  private token?: FlowToken;
  private initialized = false;
  private lastFingerprint: string | null = null;

  constructor(private deps: PriceFlowTagPublisherDeps) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    const flow = this.deps.homey.flow;
    if (typeof flow?.createToken !== 'function') {
      moduleLogger.error({ event: 'price_flow_tag_create_token_unavailable', tagId: PRICE_FLOW_TAG_ID });
      return;
    }
    try {
      this.token = await flow.createToken(PRICE_FLOW_TAG_ID, {
        type: 'string',
        title: 'PELS price list JSON',
        value: '{"today":[],"tomorrow":[],"unit":"price units"}',
      });
      this.initialized = true;
    } catch (error) {
      moduleLogger.error({
        event: 'price_flow_tag_create_token_failed',
        err: normalizeError(error),
        tagId: PRICE_FLOW_TAG_ID,
      });
    }
  }

  async publish(reason: string): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
    const exportValue = this.tryBuildExport();
    if (!exportValue) return;
    const fingerprint = priceExportFingerprint(exportValue);
    if (fingerprint === this.lastFingerprint) {
      this.deps.debugStructured({
        event: 'price_flow_tag_publish_skipped',
        reason,
        cause: 'unchanged_fingerprint',
      });
      return;
    }
    const json = JSON.stringify(exportValue);
    // Split the surfaces so a tag-write failure (or a token that never
    // initialised) does not suppress the event-driven trigger. Flows that
    // only subscribe to `price_list_updated` should keep firing even when
    // the global `pels_prices_json` tag path is broken. The
    // lastFingerprint-not-advanced retry path still covers transient
    // tag-write errors on the next publish.
    let tagWriteOk = false;
    if (this.initialized) {
      try {
        await this.setToken(json);
        tagWriteOk = true;
      } catch (error) {
        moduleLogger.error({ event: 'price_flow_tag_write_failed', err: normalizeError(error), reason });
      }
    } else {
      this.deps.debugStructured({
        event: 'price_flow_tag_publish_trigger_only',
        reason,
        cause: 'tag_not_initialized',
      });
    }
    let triggerFireOk = false;
    try {
      await this.fireTrigger(json, reason);
      triggerFireOk = true;
    } catch (error) {
      moduleLogger.error({ event: 'price_flow_tag_trigger_fire_failed', err: normalizeError(error), reason });
    }
    // Only advance the fingerprint when both surfaces published cleanly —
    // otherwise the next publish would skip this payload on the failed
    // surface (the retry-on-failure path).
    if (tagWriteOk && triggerFireOk) {
      this.lastFingerprint = fingerprint;
    }
  }

  private tryBuildExport(): PriceExportV1 | null {
    try {
      return this.buildExport();
    } catch (error) {
      moduleLogger.error({ event: 'price_flow_tag_build_export_failed', err: normalizeError(error) });
      return null;
    }
  }

  private buildExport(): PriceExportV1 {
    const timeZone = this.deps.homey.clock.getTimezone();
    const now = new Date();
    const store = this.deps.combinedPricesReader.readStore(now, timeZone);
    return buildPriceExport({ store, now, timeZone });
  }

  private async setToken(value: string): Promise<void> {
    if (!this.token) throw new Error('PriceFlowTagPublisher: token not initialized');
    await this.token.setValue(value);
  }

  private async fireTrigger(json: string, reason: string): Promise<void> {
    const flow = this.deps.homey.flow;
    if (typeof flow?.getTriggerCard !== 'function') {
      throw new Error('PriceFlowTagPublisher: homey.flow.getTriggerCard unavailable');
    }
    const card = flow.getTriggerCard(PRICE_LIST_UPDATED_TRIGGER_ID);
    await card.trigger({ prices_json: json });
    this.deps.debugStructured({ event: 'price_list_updated_fired', reason });
  }
}
