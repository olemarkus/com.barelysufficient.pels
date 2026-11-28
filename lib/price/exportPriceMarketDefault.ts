import type { SettingsUiHubMarketRead } from '../../packages/contracts/src/settingsUi/webApp';
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import { normalizeError } from '../utils/errorUtils';
import { EXPORT_PRICE_ENABLED, EXPORT_PRICE_SOURCE } from '../utils/settingsKeys';
import { readSettingsKeyList, type InstallAtBoot } from '../utils/settingsKeyList';
import type { TimerRegistry } from '../utils/timerRegistry';

const defaultLogger = getLogger('price/export-price-market-default');

const TIMER_NAME = 'exportPriceMarketDefault';
/** Homey answers the country within seconds of boot; this only covers a slow or failed read. */
const ATTEMPT_INTERVAL_MS = 30_000;
/** ~10 minutes. A new install whose country never answers keeps no export price. */
const MAX_ATTEMPTS = 20;

/**
 * Markets where a new install prices its export from Homey Energy's own feed-in
 * terms: there, exported solar earns far less than imported power costs, so the
 * planners need the feed-in price from the first day (owner ruling 2026-11-28).
 */
const HOMEY_FEED_IN_MARKETS: ReadonlySet<string> = new Set(['NL']);

export type ExportPriceMarketDefaultDeps = {
  /** Only a new install takes the market default (`classifyInstallAtBoot`). */
  installAtBoot: InstallAtBoot;
  settings: Pick<SettingsPort, 'getKeys' | 'set'>;
  readHubMarket: () => Promise<SettingsUiHubMarketRead>;
  timers: TimerRegistry;
};

type AttemptResult =
  | { result: 'owner_chose' }
  | { result: 'homey_feed_in'; country: string }
  | { result: 'not_this_market'; country: string }
  | { result: 'retry'; reasonCode: 'settings_unreadable' | 'market_unavailable' };

type KeysState = 'unwritten' | 'written' | 'unreadable';

const readKeysState = (settings: Pick<SettingsPort, 'getKeys'>): KeysState => {
  const list = readSettingsKeyList(settings);
  if (list.status === 'unavailable') return 'unreadable';
  return list.keys.includes(EXPORT_PRICE_ENABLED) || list.keys.includes(EXPORT_PRICE_SOURCE)
    ? 'written' : 'unwritten';
};

/**
 * Once, on a new install in a market listed above: turn on the export price
 * with Homey Energy as its source, so PELS follows the feed-in terms the owner
 * keeps in Homey. The writes are the ones the Electricity prices page makes, so
 * the settings handlers react to them like an owner's change. An export setting
 * the owner has already written settles the question, and an existing install
 * keeps what it is paid.
 */
export class ExportPriceMarketDefault {
  private attempt = 0;

  constructor(private readonly deps: ExportPriceMarketDefaultDeps) {}

  start(): void {
    if (this.deps.installAtBoot !== 'new') return;
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    this.attempt += 1;
    this.deps.timers.registerTimeout(TIMER_NAME, setTimeout(() => {
      this.runAttempt();
    }, delayMs));
  }

  private finish(): void {
    this.deps.timers.clear(TIMER_NAME);
  }

  private runAttempt(): void {
    this.attemptOnce()
      .then((step) => {
        // Teardown fence: a read that resolves after `onUninit` writes nothing.
        if (!this.deps.timers.has(TIMER_NAME)) return;
        this.conclude(step);
      })
      .catch((error: unknown) => {
        defaultLogger.error({ event: 'export_price_market_default_failed', err: normalizeError(error) });
        this.finish();
      });
  }

  private async attemptOnce(): Promise<AttemptResult> {
    if (readKeysState(this.deps.settings) === 'written') return { result: 'owner_chose' };
    const market = await this.deps.readHubMarket();
    // Read again after the await: the settings UI is reachable meanwhile.
    const state = readKeysState(this.deps.settings);
    if (state === 'written') return { result: 'owner_chose' };
    if (state === 'unreadable') return { result: 'retry', reasonCode: 'settings_unreadable' };
    if (market.state !== 'resolved') return { result: 'retry', reasonCode: 'market_unavailable' };
    return HOMEY_FEED_IN_MARKETS.has(market.country)
      ? { result: 'homey_feed_in', country: market.country }
      : { result: 'not_this_market', country: market.country };
  }

  private conclude(step: AttemptResult): void {
    if (step.result === 'retry') {
      if (this.attempt >= MAX_ATTEMPTS) {
        defaultLogger.info({
          event: 'export_price_market_default_gave_up', reasonCode: step.reasonCode, attempts: this.attempt,
        });
        this.finish();
        return;
      }
      this.schedule(ATTEMPT_INTERVAL_MS);
      return;
    }
    if (step.result === 'homey_feed_in') {
      this.deps.settings.set(EXPORT_PRICE_SOURCE, 'homey_energy');
      this.deps.settings.set(EXPORT_PRICE_ENABLED, true);
    }
    defaultLogger.info({
      event: 'export_price_market_default_settled',
      outcome: step.result,
      ...(step.result === 'owner_chose' ? {} : { country: step.country }),
    });
    this.finish();
  }
}
