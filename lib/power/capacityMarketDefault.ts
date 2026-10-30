import type { SettingsUiHubMarketRead } from '../../packages/contracts/src/settingsUi/webApp';
import { getLogger } from '../logging/logger';
import type { SettingsPort } from '../ports/homeyRuntime';
import { normalizeError } from '../utils/errorUtils';
import { CAPACITY_ENABLED } from '../utils/settingsKeys';
import { readSettingsKeyList, type InstallAtBoot } from '../utils/settingsKeyList';
import type { TimerRegistry } from '../utils/timerRegistry';

const defaultLogger = getLogger('power/capacity-market-default');

const TIMER_NAME = 'capacityMarketDefault';
/** Homey answers the country within seconds of boot; this only covers a slow or failed read. */
const ATTEMPT_INTERVAL_MS = 30_000;
/** ~10 minutes. A new install whose country never answers keeps the built-in default. */
const MAX_ATTEMPTS = 20;

/**
 * Markets whose households pay for a measured peak: Norway bills the hourly
 * peak and Flanders the quarter-hour peak. Belgium is in as a whole, because a
 * country code cannot tell Flanders from Wallonia and Brussels.
 */
const MEASURED_PEAK_MARKETS: ReadonlySet<string> = new Set(['NO', 'BE']);

export type CapacityMarketDefaultDeps = {
  /**
   * Only a new install takes the market default (`classifyInstallAtBoot`); an
   * existing one keeps the posture it has been running on.
   */
  installAtBoot: InstallAtBoot;
  settings: Pick<SettingsPort, 'getKeys' | 'set'>;
  readHubMarket: () => Promise<SettingsUiHubMarketRead>;
  timers: TimerRegistry;
};

type SwitchState = 'unwritten' | 'written' | 'unreadable';

type AttemptResult =
  | { result: 'owner_chose' }
  | { result: 'keep_on'; country: string }
  | { result: 'turn_off'; country: string }
  | { result: 'retry'; reasonCode: 'settings_unreadable' | 'market_unavailable' };

const readSwitchState = (settings: Pick<SettingsPort, 'getKeys'>): SwitchState => {
  const list = readSettingsKeyList(settings);
  if (list.status === 'unavailable') return 'unreadable';
  return list.keys.includes(CAPACITY_ENABLED) ? 'written' : 'unwritten';
};

/**
 * Once, on a new install: turn Capacity limit off when the hub is outside the
 * markets that bill a measured peak. Inside them the never-written switch keeps
 * the runtime's built-in default (on), so nothing is written. A switch the owner
 * has already written settles the question, and the write itself is the same
 * one the owner's Turn off Capacity limit makes, so the settings handlers react
 * to it like an owner's change.
 */
export class CapacityMarketDefault {
  private attempt = 0;

  constructor(private readonly deps: CapacityMarketDefaultDeps) {}

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
        // Teardown fence: `onUninit` clears every registered timer, and this
        // entry stays registered for the whole attempt, so a read that resolves
        // after teardown writes nothing.
        if (!this.deps.timers.has(TIMER_NAME)) return;
        this.conclude(step);
      })
      .catch((error: unknown) => {
        defaultLogger.error({ event: 'capacity_market_default_failed', err: normalizeError(error) });
        this.finish();
      });
  }

  private async attemptOnce(): Promise<AttemptResult> {
    if (readSwitchState(this.deps.settings) === 'written') return { result: 'owner_chose' };
    const market = await this.deps.readHubMarket();
    // Read again after the await: the settings UI is reachable meanwhile.
    const state = readSwitchState(this.deps.settings);
    if (state === 'written') return { result: 'owner_chose' };
    if (state === 'unreadable') return { result: 'retry', reasonCode: 'settings_unreadable' };
    if (market.state !== 'resolved') return { result: 'retry', reasonCode: 'market_unavailable' };
    return MEASURED_PEAK_MARKETS.has(market.country)
      ? { result: 'keep_on', country: market.country }
      : { result: 'turn_off', country: market.country };
  }

  private conclude(step: AttemptResult): void {
    if (step.result === 'retry') {
      if (this.attempt >= MAX_ATTEMPTS) {
        defaultLogger.info({
          event: 'capacity_market_default_gave_up',
          reasonCode: step.reasonCode,
          attempts: this.attempt,
        });
        this.finish();
        return;
      }
      this.schedule(ATTEMPT_INTERVAL_MS);
      return;
    }
    if (step.result === 'turn_off') this.deps.settings.set(CAPACITY_ENABLED, false);
    defaultLogger.info({
      event: 'capacity_market_default_settled',
      outcome: step.result,
      ...(step.result === 'owner_chose' ? {} : { country: step.country }),
    });
    this.finish();
  }
}
