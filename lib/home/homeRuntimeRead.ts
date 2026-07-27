/**
 * Per-home runtime READ port (multi-home).
 *
 * The settings UI needs to show ONE sub-home's already-committed control state.
 * The per-home runtimes live behind `HomeRuntimeRegistry`, a private field of
 * `AppServiceWiring`, so the registry itself is never handed out. This port is
 * the narrow, provenance-free surface published on `AppContext` instead — the
 * `HomeMembershipPort` precedent.
 *
 * READ-ONLY BY CONSTRUCTION. Every field is either a value the runtime has
 * ALREADY committed — the last committed plan snapshot, the home's live tracker
 * state, the bundle's diagnostics — or PURELY DERIVED from one at read time.
 * Three per-device fields inside the served plan are the derived kind:
 * `observationStale` (folds the observed state against the wall clock),
 * `idleClassification` and `evChargingState` (both look up the observer's last
 * recorded result). All three are side-effect free, which is the bar anything
 * added here must also clear: reading never rebuilds a plan, never refreshes or
 * decorates a device snapshot, never arms a timer, and never actuates.
 *
 * In particular the port deliberately exposes NO device list: the app's
 * decorated snapshot getter re-runs a full snapshot read + decorate on every
 * access, which would turn a cheap UI poll into a snapshot rebuild.
 *
 * The served objects are the runtime's own state objects, handed over without a
 * deep copy (the main home's `ui_power`/`ui_plan` path does the same). Consumers
 * must treat a reading as immutable and serialize it, never mutate it.
 *
 * Payload typing: `lib/home` is a leaf domain and may not depend on a domain
 * peer (`no-home-to-peer`, severity error in `.dependency-cruiser.cjs`), so the
 * plan and tracker payloads come from `packages/contracts` — type-only, because
 * a VALUE dependency on contracts crashes boot (the sanitize step drops it from
 * the shipped bundle).
 *
 * {@link HomeRuntimeDiagnostics} is the single declaration of that block; the
 * setup-layer bundle aliases it, since `setup → lib` is the legal direction.
 * {@link HomeRuntimeCapacityScalars} is the one genuine duplicate: its peer
 * declaration `CapacityScalarSettings` lives in `lib/power`, which this module
 * may not reach. The drift is asymmetric. REMOVING or retyping a field there
 * fails the build. ADDING one does not: the producer spreads the concrete
 * block, and a spread is exempt from excess-property checking, so the new field
 * ships in the payload while staying invisible in this contract — a silent
 * widening, not a silent omission. Widening the block therefore stays a
 * deliberate act on both sides. TODO.md carries the consolidation (move the
 * scalar block to `lib/utils`, the precedent `HomeId` already set).
 */
import type { PowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import type { SettingsUiPlanSnapshot } from '../../packages/contracts/src/settingsUiApi';
import type { HomeId } from './homeConfig';

/**
 * A home's capacity scalar block: hard cap, safety margin, dry-run flag.
 * Structural duplicate of `CapacityScalarSettings`
 * (`lib/power/capacitySettingsStore`) — see the module doc.
 */
export type HomeRuntimeCapacityScalars = Readonly<{
  limitKw: number;
  marginKw: number;
  dryRun: boolean;
}>;

/**
 * A home runtime's diagnostics block — the single declaration, aliased by
 * `HomeCapacityBundleDiagnostics` in the setup layer that produces it.
 */
export type HomeRuntimeDiagnostics = Readonly<{
  homeId: HomeId;
  meterDeviceId: string | null;
  /**
   * The EFFECTIVE operating mode this home plans with: its pinned
   * `operating_mode:<homeId>` when that names a configured mode, else the
   * global mode (resolution: `resolveHomeOperatingMode`). Purely derived at
   * read time from already-committed settings state.
   */
  operatingMode: string;
  /** Effective no-actuation switch (persisted flag, membership gate, or source-epoch gate). */
  dryRunEffective: boolean;
  /** Last meter reading this home's guard saw (kW), or null before its first sample. */
  lastMeterPowerKw: number | null;
  capacityScalars: HomeRuntimeCapacityScalars;
  lastDeviceControlledMs: Readonly<Record<string, number>>;
}>;

/** One home runtime's already-committed state. */
export type HomeRuntimeReading = Readonly<{
  homeId: HomeId;
  /** Last COMMITTED plan, serialized for the UI; null before the first commit. */
  plan: SettingsUiPlanSnapshot | null;
  /** When that plan was committed; null before the first commit. */
  planUpdatedAtMs: number | null;
  /** This home's own power tracker state (its meter only, never the whole home). */
  powerTracker: PowerTrackerState;
  diagnostics: HomeRuntimeDiagnostics;
}>;

/**
 * Typed semantic result. `unavailable` is the producer's complete
 * classification of every non-serving case — no such sub-home, a home whose
 * runtime has been torn down, the registry not being wired yet (before
 * `initHomeRuntimeRegistry`) or any more (after uninit), and a throw while
 * assembling the reading. Nothing escapes as an exception, so a consumer never
 * has to turn a raw failure into an unclassified error of its own. Consumers
 * must render this as "no data for this home" and must never substitute
 * another home's values or a fabricated default.
 */
export type HomeRuntimeReadResult =
  | Readonly<{ state: 'resolved'; reading: HomeRuntimeReading }>
  | Readonly<{ state: 'unavailable' }>;

/**
 * Control surface published on `AppContext.homeRuntimeRead`. Sub-homes ONLY:
 * the main home is not a bundle, and its equivalents are the existing
 * unsuffixed `AppContext` reads — so `MAIN_HOME_ID` resolves to `unavailable`
 * here by design, and a main-home read must keep using the existing path.
 */
export type HomeRuntimeReadPort = {
  /** Already-committed state for one sub-home. Pure read; never rebuilds. */
  readHome(homeId: HomeId): HomeRuntimeReadResult;
};
