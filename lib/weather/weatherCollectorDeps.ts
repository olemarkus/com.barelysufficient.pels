import type { Logger as PinoLogger } from 'pino';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
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
  /**
   * Resolved fingerprint of the whole-home metering arrangement, composed by
   * the setup layer (`setup/weatherMeterScopeSignature.ts`) from only the
   * settings relevant to the active producer. `lib/weather` must not read the
   * homes config itself (the `no-weather-to-peer` boundary). `undefined` means
   * a required setting is unavailable; the collector then keeps the stamped
   * signature and never invalidates on it — ambiguity is not change evidence.
   */
  readMeterScopeSignature: () => string | undefined;
  /**
   * Main's meter selection, resolved by the setup layer
   * (`setup/mainMeterSettings.ts`) — the same read the scope fingerprint is
   * composed from; `lib/weather` must not read settings itself. Constrains the
   * historical-kWh election (`resolveMeterDailyKwh`): with an EXPLICIT
   * selection only that meter may win — the open probe would otherwise
   * re-admit a still-installed previous meter whose pre-switch days match the
   * retained power-tracker history strongest, re-vouching old-scope kWh right
   * after a scope invalidation. `null` (Automatic) keeps the open probe: the
   * Automatic pick's resolved identity is structurally unavailable at this
   * seam (the fingerprint's documented limitation). `unavailable` defers the
   * election — a failed read must not widen it back to every installed meter.
   */
  readMainMeterSelection: () => MainMeterSelection;
  /**
   * The configured whole-home power source, resolved by the setup layer from
   * the same adapter the scope fingerprint's source arm is composed from
   * (`setup/powerSourceSettings.ts`). Gates the historical-kWh election: the
   * election exists only for the Homey Energy producer — Flow samples come
   * from the user's own wiring, not an id-bearing meter, so no installed
   * meter is that scope's producer, and probing one anyway would let it
   * validate against the retained pre-switch tracker buckets and re-vouch
   * old-scope kWh right after a source-switch invalidation. `suspect` (a
   * transiently unreadable setting) defers the launch, like an unavailable
   * Main selection. The source union is declared structurally because
   * `lib/weather` must not import `lib/power` (`no-weather-to-peer`); it
   * mirrors `PowerSource` in `lib/power/powerSource.ts`.
   */
  readPowerSource: () => { state: 'resolved'; value: 'homey_energy' | 'flow' } | { state: 'suspect' };
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
