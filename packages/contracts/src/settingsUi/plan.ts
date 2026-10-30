import type { CapacityPeriodMinutes } from '../capacitySettings.js';
import type { DeviceOverviewSnapshot } from '../deviceOverview.js';
import type { DeviceStatus } from '../deviceStatus.js';
import type { SettingsUiHomeScope } from '../homeScopedRead.js';

// One starved state, no cause bucket. The flat `capacity | budget` split was
// removed 2026-08-04: it was a momentary snapshot of whichever constraint bound
// on the last accumulation tick, so it flipped mid-hold, and every surface that
// branched on it (badge, widget chip, row copy, and the rescue gate) flipped with
// it. The granular `DeviceDiagnosticsStarvationCountingCause` — which does carry
// real diagnostic value — is unaffected and still reaches device detail and the
// `device_starvation_*` logs.
// `startedAtMs` was removed 2026-08-07: nothing in `lib/`, `setup/` or
// `packages/` ever read it. The surfaces that show a hold's age render
// `accumulatedMs` (the time actually spent starved), which is not the same
// quantity — an episode start says nothing about how much of it counted.
export type SettingsUiPlanDeviceStarvation = {
  isStarved: boolean;
  accumulatedMs: number;
};

/**
 * The limit binding this plan cycle: the lowest of the enabled capacity pace,
 * daily budget pace and grid import target, `null` when none is enabled. One
 * source, never a "both": the grid wins an exact tie, and capacity wins a near
 * tie with daily pacing (`resolveSoftLimitSource`, `lib/plan/planContext.ts`).
 */
export type SoftLimitSource = 'capacity' | 'daily' | 'grid' | null;

/**
 * NO `[key: string]: unknown` index signature — same reasoning as
 * `SettingsUiPlanDeviceSnapshot` below, which carries the full rationale. This
 * shape lost several fixture-only fields (`hardLimitKw`, a duplicate of
 * `hardCapLimitKw`; `powerKnown`) that only compiled because the signature
 * accepted anything.
 */
export type SettingsUiPlanMetaSnapshotBase = {
  /**
   * Always a number: a plan exists only behind the measurement gate, so the
   * cycle behind every snapshot carries a reading (on the one unmeasured
   * build — the fail-closed pass — it is the carried reading). Whether the
   * meter still confirms it is `powerIsMeasured`'s fact, and the figures
   * derived from the total exist only behind it. Staleness short of that is
   * not a plan-meta state at all; the power payload's own read carries it for
   * the banner.
   */
  totalKw: number;
  softLimitKw: number | null;
  capacitySoftLimitKw: number | null;
  gridImportLimitKw: number | null;
  gridImportTargetKw: number | null;
  /** `null` = no daily budget axis this cycle. Always emitted. */
  budgetPaceKw: number | null;
  projectedExemptKw: number | null;
  softLimitSource: SoftLimitSource;
  /** From `capacitySettings.limitKw` — a plain number, never absent or null. */
  hardCapLimitKw: number;
  capacityPeriodMinutes: CapacityPeriodMinutes;
  /** Whether usedKWh covers the whole elapsed part of this capacity period. */
  capacityPeriodCoverageComplete: boolean;
  usedKWh: number;
  hourBudgetKWh: number;
  minutesRemaining: number;
  /** Genuinely absent until the hour has bucket data. */
  hourControlledKWh?: number;
  hourUncontrolledKWh?: number;
  /**
   * The meter evidence stamp this cycle planned against — always present (see
   * `totalKw`): the latest sample's own stamp, or, once the reading is judged
   * frozen, when it took its value. The no-readings banner ages the readings
   * fact instead, which moves back earlier, as soon as the reading is suspect.
   */
  lastPowerUpdateMs: number;
};

/**
 * The power-derived figures the hero draws, present ONLY when the cycle had a
 * measurement. On the one unmeasured cycle (the silent-meter fail-closed pass)
 * the wire carries the bare signal and no headroom or managed/background
 * split at all — never a stand-in number the view could compare or subtract
 * (owner ruling 2026-09-02). The view branches on the discriminant once, at
 * the hero's mount, and renders nothing computed when it is false.
 *
 * No `headroomKw`: the hero derives its above-safe-pace state and overshoot
 * from the two numbers it prints (`totalKw` against `softLimitKw`), so a
 * headroom on the wire would be a second truth nothing renders.
 */
export type SettingsUiPlanMetaMeasuredFields = {
  powerIsMeasured: true;
  controlledKw: number;
  uncontrolledKw: number;
};

export type SettingsUiPlanMetaUnmeasuredFields = {
  powerIsMeasured: false;
};

export type SettingsUiPlanMetaSnapshot = SettingsUiPlanMetaSnapshotBase
  & (SettingsUiPlanMetaMeasuredFields | SettingsUiPlanMetaUnmeasuredFields);

/**
 * A home battery on the overview, beyond its resolved card status: what it is
 * doing, for the hero line that names a battery holding the limit. `power` is
 * the battery's own reading, unsigned (the activity gives the direction).
 * `holdsLimit`: PELS holds it to hold the limit, it is available and it
 * reports supplying, the one case the hero names; resolved by the producer
 * (`lib/plan/batteryStatusReadModel.ts`).
 */
export type SettingsUiPlanHomeBattery = {
  activity: 'supplying' | 'charging' | 'own_mode' | 'waiting';
  power: { kind: 'observed'; kw: number } | { kind: 'absent' };
  holdsLimit: boolean;
};

/**
 * NO `[key: string]: unknown` index signature, deliberately. It used to carry
 * one, and that made every field removal on this wire type unenforceable: a
 * consumer kept compiling against a field the producer no longer emits, so a
 * dead read survived a passing typecheck (the atomic-temperature-facet
 * migration left exactly such a read behind in `PlanOverview.tsx`). It also hid
 * the reverse — `carChargingState` travelled on the wire and was READ by the
 * EV card text while this contract never declared it. Every field the producer
 * emits is declared here; a new one is a deliberate edit, not an accident.
 * Resolved presentation plus measurements and identity cross this seam;
 * control axes stay with their runtime owners.
 */
export type SettingsUiPlanDeviceSnapshot = Pick<DeviceOverviewSnapshot,
  'controllable' | 'available' | 'isEvCharger' | 'stateOfCharge'
  | 'currentDrawKw'> & {
  status: DeviceStatus;
  id: string;
  name: string;
  budgetExempt?: boolean;
  boostActive: boolean;
  starvation?: SettingsUiPlanDeviceStarvation;
  /** Present on a home battery's card, and only there. */
  homeBattery?: SettingsUiPlanHomeBattery;
};

export type SettingsUiPlanDevice = SettingsUiPlanDeviceSnapshot;

export type SettingsUiPlanSnapshot = {
  generatedAtMs?: number;
  meta?: SettingsUiPlanMetaSnapshot;
  devices?: SettingsUiPlanDeviceSnapshot[];
  /**
   * The held-back devices the Overview's "Let it run now" chip may offer the
   * rescue on: task-free, with a known target, by the rule the rescue's preview
   * and create re-check against the live list (`selectRescuableDeviceIds`). It
   * rides the plan so an open Overview reads nothing extra per plan push. A
   * snapshot: a chip shown from it can still come back `not_rescuable` or
   * `no_target`. A meter area's plan lists none, since the rescue lane is the
   * Main home's.
   */
  rescuableDeviceIds: string[];
};

export type SettingsUiPlanPayload = {
  plan: SettingsUiPlanSnapshot | null;
  // Present only on a `?homeId=` read; absent keeps the whole-home payload
  // byte-identical. `unavailable` means `plan: null` carries NO information
  // about that home — it is the empty shape, not "this home has no plan".
  homeScope?: SettingsUiHomeScope;
};
