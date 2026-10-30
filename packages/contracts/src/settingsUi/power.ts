import type { CapacityScalarSettings } from '../capacitySettings.js';
import type { DailyBudgetUiRead } from '../dailyBudgetTypes.js';
import type { SettingsUiHomeScope } from '../homeScopedRead.js';
import type { SettingsUiPowerTracker } from '../powerTrackerTypes.js';

/** One pickable whole-home meter (id + display name); the producer already narrowed to meters. */
export type HomeyEnergyMeterEntry = { id: string; name: string };

export type SettingsUiPowerStatus = {
  headroomKw?: number;
  lastPowerUpdate?: number | null;
  priceLevel?: string | null;
  powerNowKw?: number | null;
  /** Whether the plan behind this status was measured; derived from `powerNowKw`. */
  powerKnown?: boolean;
  /** The effective (membership-gated) dry-run the publishing home actuates on. */
  dryRunEffective?: boolean;
  /** Devices the plan currently holds off; the Limits card's count. */
  devicesOff?: number;
  /** Which ceiling is limiting the home right now; the Limits card's status line. */
  limitReason?: 'none' | 'hourly' | 'daily' | 'both';
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number | null;
  shortfallBudgetHeadroomKw?: number | null;
  // Instantaneous cap headroom — log/diagnostic parity only. Never derive an
  // over-cap alarm from this (the cap is an hourly-average ceiling); consume
  // the producer-resolved trajectory flag below instead.
  hardCapHeadroomKw?: number | null;
  // Producer-resolved "Above hard cap" trajectory verdict: projected this-hour
  // energy past the cap's hourly kWh (`lib/plan/pelsStatus.ts`).
  projectedOverHardCap?: boolean;
};

/**
 * Why a power-status read carries no live status. Every arm is one specific,
 * producer- or seam-owned cause — no catch-all:
 *
 * - `no_measurement` — the home's measurement gate is shut: its live tracker
 *   holds no measurement latch for this home's meter (first-ever boot, an
 *   in-place meter swap cleared it, or a corrupt tracker restore). The latch
 *   is durable on purpose: an ordinary restart of an ever-measured home
 *   restores it (the planner's restored-sample policy) and stays `live`,
 *   with the running planner publishing a status promptly. When this arm DOES
 *   resolve, no status is served as live (`lib/power/powerMeasurementGate.ts`).
 * - `no_status_recorded` — a measurement exists but the home has published no
 *   status this run yet (first plan not yet built).
 * - `home_scope_unavailable` — the `?homeId=` read could not be served; the
 *   payload is the empty shape and its `homeScope` block says the same.
 * - `read_failed` — the WebView-side transport adapter could not obtain or
 *   validate a payload at all (the Homey API bridge is an untrusted transport;
 *   the client classifies its own failed read once, at that seam).
 */
export type SettingsUiPowerStatusUnavailableReason =
  | 'no_measurement'
  | 'no_status_recorded'
  | 'home_scope_unavailable'
  | 'read_failed';

/**
 * The classified result of reading the home's live status. The producer
 * (`getSettingsUiPower` / `powerPayloadForHome`, setup/settingsUiApi.ts)
 * resolves it at the read boundary: `live` means the running planner vouches
 * for the status (the home's measurement gate is open, so the status is
 * THIS run's); `unavailable` means no live status claim exists and the reason
 * arm says exactly why. Consumers branch on `state` and never re-derive
 * liveness from blob fields such as `lastPowerUpdate`.
 */
export type SettingsUiPowerStatusRead =
  | { readonly state: 'live'; readonly status: SettingsUiPowerStatus }
  | { readonly state: 'unavailable'; readonly reason: SettingsUiPowerStatusUnavailableReason };

/**
 * The one readings fact the UI may branch on before touching power numbers:
 * has this home EVER received a whole-home reading, and when was the last.
 * Resolved ONCE at the producer from the live tracker's own stamp — the UI
 * never re-derives it from tracker fields or persisted-blob fallbacks. The
 * `never` arm is the no-readings banner's onboarding lead; `received` +
 * a stale age is its stopped lead.
 */
export type SettingsUiPowerReadings =
  | { readonly state: 'never' }
  | { readonly state: 'received'; readonly lastPowerUpdateMs: number };

/**
 * The highest completed 15-minute average in the current Homey-local month.
 * `no_completed_quarter` is the genuine domain state of a month that has not
 * finished one yet; `unavailable` is a runtime that could not answer.
 */
export type SettingsUiCapacityPeak =
  | { readonly state: 'recorded'; readonly peakKw: number }
  | { readonly state: 'no_completed_quarter' }
  | { readonly state: 'unavailable' };

/**
 * The capacity scalars a payload carries, or `unavailable` when the runtime
 * could not answer (a boot window in which the app object has no seam yet, or
 * a home with no runtime).
 */
export type SettingsUiCapacityScalarsRead =
  | { readonly state: 'resolved'; readonly scalars: CapacityScalarSettings }
  | { readonly state: 'unavailable' };

/**
 * Whether the owner has saved the hard capacity limit. The runtime settings
 * owner resolves this from `getKeys()`; consumers must not infer it from a
 * fallback scalar value or a nullable SDK read.
 */
export type SettingsUiHardCapConfigurationRead =
  | { readonly state: 'resolved'; readonly configured: boolean }
  | { readonly state: 'unavailable' };

export type SettingsUiPowerPayload = {
  /**
   * Usage HISTORY (buckets, daily totals, solar families) — always an object;
   * `{}` is the empty history. History and readings are different facts: a
   * meter swap clears the readings latch while the buckets survive.
   */
  tracker: SettingsUiPowerTracker;
  /** Producer-resolved readings fact; see `SettingsUiPowerReadings`. */
  readings: SettingsUiPowerReadings;
  status: SettingsUiPowerStatusRead;
  /**
   * The running app's own capacity scalars for the home this payload
   * describes. The running app retains its last-good values when a persisted
   * key is absent or malformed, so a freshly opened WebView must render these
   * rather than infer a boot default from settings absence.
   *
   * `dryRun` is the home's CONFIGURED simulation flag. A meter area's
   * EFFECTIVE posture (membership and meter-source gates on top of the flag)
   * stays where it always was, in the scoped status blob.
   */
  capacityScalars: SettingsUiCapacityScalarsRead;
  /** Authoritative persisted-configuration provenance for the hard cap. */
  hardCapConfiguration: SettingsUiHardCapConfigurationRead;
  /** Measured tariff evidence for a monthly quarter-hour peak. */
  capacityPeak: SettingsUiCapacityPeak;
  // Home-level "this home has PRODUCTION surfaces" gate for the Usage tab's
  // Solar card (which cannot read the lazy-loaded devices payload). True only
  // when a tracked solar/PV device exists (`hasSolarProductionCandidate`) —
  // production is source-independent, and without such a device the generation
  // buckets can never fill and the card must not promise data (see
  // getSettingsUiPower). EXPORT is a separate axis and is not gated by this
  // flag. Optional: realtime status-only pushes don't carry it — consumers
  // treat absence as false and fall back to the recorded solar buckets.
  hasManagedSolarDevice?: boolean;
  // Present only on a `?homeId=` read; absent keeps the whole-home payload
  // byte-identical (realtime pushes never carry it either). `unavailable` means
  // `tracker: null` / the unavailable status arm are the empty shape, NOT a
  // measured idle.
  homeScope?: SettingsUiHomeScope;
};

export type SettingsUiResetPowerStatsResponse = {
  power: SettingsUiPowerPayload;
  dailyBudget: DailyBudgetUiRead;
};
