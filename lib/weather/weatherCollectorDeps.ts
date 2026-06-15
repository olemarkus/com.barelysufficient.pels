import type { Logger as PinoLogger } from 'pino';
import type {
  WeatherAdvisorSettings,
  WeatherHistoryState,
} from '../../packages/contracts/src/weatherAdvisorTypes';
import type { RawHomeyDeviceLike } from '../utils/types';
import type { WeatherHistoryStore } from './weatherHistoryStore';
import type { MetForecastFetchResult } from './metForecast';

/**
 * Injected collaborators for `WeatherCollector`. Split into its own module to
 * keep the collector under its size budget. Every outward seam (SDK reads, Web
 * API, kWh totals, the MET fetch, the energy-signature recompute, the daily-
 * budget apply) is a flat callback so `lib/weather` imports no peer domain.
 */
export type WeatherCollectorDeps = {
  store: WeatherHistoryStore;
  readDevice: (deviceId: string) => Promise<RawHomeyDeviceLike>;
  /** Read-only GET against the Homey Web API (Insights backfills + meter discovery). */
  fetchInsights: (path: string) => Promise<unknown>;
  /** Flat kWh totals for a local day, sourced from the power tracker by the factory. */
  getDailyKwh: (dateKey: string) => { total?: number; controlled?: number; uncontrolled?: number };
  /** Whether PELS manages (controls) a device — drives the historical controlled-split backfill. */
  isManagedDevice: (deviceId: string) => boolean;
  getUnreliablePeriods: () => Array<{ start: number; end: number }>;
  /**
   * Censoring evidence for a local day (PELS-limited comfort/capacity, or a
   * deadline-miss-to-budget), composed by the factory from diagnostics + smart-
   * task history. Absent fields = signal unavailable (treated as unsuppressed).
   */
  getDaySuppression: (dateKey: string) => {
    targetDeficitMs?: number;
    blockedByHeadroomMs?: number;
    deadlineMissedToBudget?: boolean;
  };
  getSettings: () => WeatherAdvisorSettings;
  getNowMs: () => number;
  getTimeZone: () => string;
  /**
   * Fetches tomorrow's MET Norway forecast summary. Injected so `lib/weather`
   * never owns HTTP/SDK specifics (the setup layer wires the real `fetch`, the
   * hub coordinates, and the mandatory User-Agent). The setup-supplied
   * `ifModifiedSince` is the cached `lastModified` the collector hands back
   * here. Absent ⇒ the MET source is off and the collector skips refresh.
   */
  fetchForecast?: (opts: { ifModifiedSince?: string }) => Promise<MetForecastFetchResult>;
  /**
   * Recomputes derived fields (energy-signature fit, budget suggestion) after
   * the records change. Injected so the collector stays a pure data layer.
   */
  recomputeDerived?: (state: WeatherHistoryState) => WeatherHistoryState;
  /**
   * Applies the suggested daily budget at a rollup when the user opted into
   * auto-apply. Returns `true` when applied, `false` when the daily budget
   * feature is off (leave-off semantics). Injected so `lib/weather` never
   * imports `lib/dailyBudget` (the `no-weather-to-peer` boundary).
   */
  applySuggestedDailyBudget?: (suggestedKwh: number) => boolean;
  /**
   * Fired once per target day, right after a successful weather auto-apply, so
   * the setup layer can fire the `daily_budget_weather_adjusted` Flow trigger.
   * A flat callback (not the SDK) keeps `lib/weather` off `flowCards`/the SDK:
   * the domain emits the values that drove the change; setup shapes the tokens.
   */
  onDailyBudgetAutoApplied?: (info: { budgetKwh: number; forecastMeanTempC: number }) => void;
  logger: PinoLogger;
};
