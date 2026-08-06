// Curtailment-surplus estimator — the INFERRED term of the solar-surplus pool.
//
// A zero-export home's inverter throttles production so net grid power pins ~0:
// measured export never appears, so the export-driven surplus pool never engages
// even when the panels could produce far more. This producer infers that hidden
// (curtailed) production as `max(0, discount(confidence) × potential − actual
// generation)` — potential from the learned PV forecast (trained on net-evidence
// hours, so the gain is not itself clamp-biased), actual generation from the
// co-sampled Homey Energy reading. The plan layer consumes the result as one flat
// `inferredSurplusKw` number; all provenance stays here (resolution in the
// producer).
//
// Safety posture (the invariants consumers rely on):
// - IMPORT GUARD: any sample with sustained-import-level net (> CURTAIL_NET_GATE_KW)
//   latches the term to null for CURTAIL_IMPORT_HOLD_DOWN_MS — sticky, so a
//   throttled plan build sampling the getter at any instant after a recent import
//   reads null. An inference must never push into real grid import; the
//   surplus gate's hardOff release (SURPLUS_ABSORB_HARD_OFF_IMPORT_KW, paired
//   just above this gate) is the consumer-side backstop.
// - VERIFICATION (outcome-based): when a surplus lift engages while this term is
//   positive, a verify window opens. TRUE curtailment un-throttles the inverter
//   and net stays ~0 (the latch never fires) ⇒ window expires ⇒ CONFIRMED. FALSE
//   inference forces the extra draw onto the grid ⇒ the latch fires inside the
//   window ⇒ REFUTED: the term zeroes and an activation-backoff-style hold
//   (15/30/60 min ladder) blocks re-engage. A CONFIRMED verdict needs POSITIVE
//   evidence, not merely the absence of a refute: an in-window co-sample near
//   the deadline (a sample outage spanning the window must not confirm blind),
//   AND the window's minimum net proving the inference was load-bearing (never
//   below −gate — a lift financed by measured export proves nothing about the
//   term) and actually absorbed (net came down to at most the standing-import
//   allowance). Anything else closes the window silently with the ladder kept.
// - CRASH-LOOP RESILIENCE: the minimal refute-ladder slice ({holdLevel,
//   holdUntilMs, importLatchUntilMs}) persists through the optional injected
//   `holdStore` on transitions only (never per tick), so a cpuwarn kill cycle
//   cannot reset the ladder back to 15-min holds; expiry is honored across
//   restarts (stale timestamps simply compare false). All other state is
//   in-memory — a restart re-arms fail-closed (eligibility-state precedent).
// - BATTERY HOMES: a tracked home battery absorbs surplus before the meter sees
//   it, making "net ~0 while curtailed" indistinguishable from "battery
//   charging" — v1 suppresses the term entirely (a batteryPowerW-discounted
//   variant needs a retained aggregate that does not exist yet).
// - HOMES WITH NO CO-TEMPORAL PRODUCTION READING: samples carry
//   `generationW: undefined` ⇒ dormancy never lifts ⇒ term null forever, with
//   zero source-branching. Flow homes now DO obtain production
//   (`lib/power/sources/generationPoll.ts`), but from a separate poll, so the
//   ingest deliberately withholds it here: `CURTAIL_SAMPLE_FRESH_MS` below is
//   stamped from the NET clock, which is only sound while the pair is read from
//   one report. A co-sampled reading can be up to 60 s older than its net,
//   stretching that 45 s to ~105 s — and a stale-LOW generation value INFLATES
//   the inferred surplus, engaging a lift on production already self-consumed
//   and pushing into real grid import. Arming this on flow needs the
//   generation's own `observedAtMs` carried into `recordSample` first; see
//   `PowerSampleRequest.coTemporalGenerationW` in `setup/powerSamplePipeline.ts`.
// - TWO-CHANNEL INGEST (once armed): a finite `netW` ALWAYS drives the net
//   channel (latch, in-window refute, window-min tracking), even when the
//   generation read transiently fails — an import must never escape the latch
//   because a different sensor blinked. Generation-dependent parts (dormancy
//   arming, the term value, confirm evidence) stay gen-gated: a gen-invalid
//   tick bumps no freshness, so the term stales to null within 45 s anyway.
// - Freshness: the term is null unless a gen-valid co-sample landed within
//   CURTAIL_SAMPLE_FRESH_MS. A junk `netW` or timestamp drops the tick whole.
//
// The estimator is SDK-free and clock-free (every entry point takes `nowMs`);
// the setup layer wires the deps (`setup/appInit/wireCurtailmentSurplus.ts`).
// Deliberately imports nothing from `lib/plan` (banned edge — see the
// no-plan-solar-coupling dep-cruiser rules); the {gate 0.30, hardOff 0.35}
// pairing is maintained by comment, not by a shared constant.

// Local guard — mirrors lib/utils/appTypeGuards.isFiniteNumber; kept local so the
// estimator stays dependency-light and unit-testable in isolation.
const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const HOUR_MS = 3_600_000;

// --- Dogfood-tunable constants (all estimator-local): the latch/window/hold
// --- durations and the confidence discounts are expected to move based on
// --- curtailment_verify_* + surplus_pool telemetry from real zero-export homes.

// A co-sample older than this cannot back the term (null). Comfortably above the
// 10 s Homey Energy poll cadence, below the plan layer's 90 s settle window.
export const CURTAIL_SAMPLE_FRESH_MS = 45_000;
// Net import above this gate latches the term to zero: it must clear the
// ~100–200 W standing import a zero-export controller holds, with margin, and
// must stay BELOW the plan gate's SURPLUS_ABSORB_HARD_OFF_IMPORT_KW (0.35) so
// the producer stops feeding before the gate-side backstop trips (no churn band).
export const CURTAIL_NET_GATE_KW = 0.30;
// Sticky import latch: how long the term stays zero after the last gate-exceeding
// sample. Plan rebuilds are throttled, so this must cover the rebuild cadence —
// a recently-importing home must read term 0 whatever instant a build samples.
export const CURTAIL_IMPORT_HOLD_DOWN_MS = 90_000;
// Outcome-verification window opened when a lift engages on a positive term:
// long enough for the inverter to un-throttle and the meter to settle, short
// enough to bound a false engage's import burst.
export const CURTAIL_VERIFY_WINDOW_MS = 300_000;
// Refuted-inference hold ladder: base × 2^(level−1) ⇒ 15/30/60 min, capped.
export const CURTAIL_HOLD_BASE_MS = 900_000;
export const CURTAIL_HOLD_MAX_LEVEL = 3;
// A CONFIRMED verdict (ladder reset) additionally requires the window's minimum
// net to have come DOWN to at most this standing-import level: a window whose
// net sat persistently at sub-gate import absorbed the lift only partially, so
// the level is withheld (silent close) even though nothing refuted. Derived as
// half the latch gate so the pair keeps tuning together.
export const CURTAIL_CONFIRM_STANDING_IMPORT_KW = CURTAIL_NET_GATE_KW / 2;
// Confidence discount applied to the forecast potential before subtracting the
// actual generation. The cost asymmetry (a mild bounded import burst vs staying
// curtailed) sets these near 1; a low-confidence fit (incl. the clamp-aware
// quantile mode, which forces 'low') carries the deeper discount.
export const CURTAIL_POTENTIAL_DISCOUNT = 0.9;
export const CURTAIL_POTENTIAL_DISCOUNT_LOW_CONF = 0.8;

/** Forecast PV potential for an hour: mean kW over the hour + fit confidence. */
export type CurtailmentPotential = {
  kw: number;
  confidence: 'low' | 'medium' | 'high';
};

/** Minimal structured-log surface (satisfied by the pino logger). */
export type CurtailmentSurplusLogger = {
  info: (obj: Record<string, unknown>) => void;
};

/** The minimal refute-ladder slice that survives a restart. Nullable timestamps
 *  express "no active hold/latch"; expired values are harmless (compare false). */
export type CurtailmentPersistedHoldState = {
  holdLevel: number;
  holdUntilMs: number | null;
  importLatchUntilMs: number | null;
};

/** Store port for the persisted hold slice. Declared here in the domain; the
 *  setup adapter (`setup/curtailmentHoldStateAdapter.ts`) owns the Homey
 *  settings read/write AND the junk normalization — `read()` hands back either
 *  a typed state or `null` (fresh start), never a partial/malformed value. */
export type CurtailmentHoldStore = {
  read: () => CurtailmentPersistedHoldState | null;
  write: (state: CurtailmentPersistedHoldState) => void;
};

export type CurtailmentSurplusDeps = {
  /** Discounted-potential source for a UTC hour-start; null = unresolvable
   *  (no fit yet / no forecast irradiance for the hour) ⇒ term fail-closed. */
  getPotential: (hourStartMs: number) => CurtailmentPotential | null;
  /** Whether a home battery is currently tracked (v1: full term suppression). */
  hasHomeBattery: () => boolean;
  /** Whether any device currently holds surplus-absorb eligibility (the lift). */
  isSurplusLiftEngaged: () => boolean;
  /** Optional persistence for the refute ladder (crash-loop resilience);
   *  absent (tests) ⇒ purely in-memory, pre-persistence behavior. */
  holdStore?: CurtailmentHoldStore;
  logger: CurtailmentSurplusLogger;
};

// Coarse term availability for transition-only logging (never per tick).
type CurtailmentTermState = 'suppressed' | 'latched' | 'hold' | 'armed';

/**
 * Whole-home curtailment-surplus estimator. `recordSample` is push-fed from the
 * power-sample pipeline (one co-sampled net+generation reading per tick);
 * `getCurtailedSurplusKw` is the flat producer read the plan wiring injects.
 * State is in-memory (restart re-arms fail-closed) except the refute-ladder
 * slice, which rehydrates from the optional `holdStore`.
 */
export class CurtailmentSurplusEstimator {
  // Inert until the home shows POSITIVE generation, so non-solar homey_energy
  // homes (generation 0) and flow homes (generation undefined) never arm.
  private dormant = true;
  private lastSampleAtMs: number | null = null;
  private lastGenerationW: number | null = null;
  private importLatchUntilMs?: number;
  private verifyWindowUntilMs?: number;
  private holdUntilMs?: number;
  // Refute escalation level (0 = clean). Reset only by a CONFIRMED verdict, so
  // consecutive refutes climb the hold ladder even across expired holds.
  private level = 0;
  // Minimum net (kW) observed while the current verify window is open — the
  // load-bearing/absorption evidence the confirm gate reads. +Infinity when no
  // window is open or no in-window net sample has landed yet.
  private windowMinNetKw = Number.POSITIVE_INFINITY;
  private lastLiftEngaged = false;
  private lastTermState: CurtailmentTermState = 'suppressed';

  constructor(private readonly deps: CurtailmentSurplusDeps) {
    // Rehydrate the refute ladder so a crash-loop cannot reset it. The adapter
    // behind `read()` has already normalized junk to null (fresh start); expired
    // timestamps are harmless — every consumer compares them against nowMs.
    const persisted = deps.holdStore?.read() ?? null;
    if (persisted) {
      this.level = persisted.holdLevel;
      this.holdUntilMs = persisted.holdUntilMs ?? undefined;
      this.importLatchUntilMs = persisted.importLatchUntilMs ?? undefined;
    }
  }

  /**
   * Fold one co-sampled pipeline tick. `netW` is the SIGNED whole-home net power
   * (import positive); `generationW` is the gross PV generation from the same
   * report, `undefined` when the home has no generation channel (flow source).
   * Boundary: a non-finite net or timestamp drops the tick whole. A non-finite
   * generation (transient gen-read failure) keeps the NET channel alive — latch,
   * refute, and window-min still advance — but bumps no term freshness and
   * carries no confirm evidence.
   */
  recordSample(netW: number, generationW: number | undefined, nowMs: number): void {
    if (!isFiniteNumber(netW) || !isFiniteNumber(nowMs)) return;
    const genValid = isFiniteNumber(generationW);
    if (this.dormant) {
      // Dormancy arming is gen-gated: flow homes (gen undefined) and non-solar
      // homes (gen 0) stay fully inert — no latch churn, no logs.
      if (!genValid || generationW <= 0) return;
      this.dormant = false;
      // Seed the lift baseline to the CURRENT binding lift state, so a lift
      // already engaged before the home first produced is NOT read as a rising
      // edge on this arming tick (which would open a spurious window on load the
      // inference never financed).
      this.lastLiftEngaged = this.deps.isSurplusLiftEngaged();
    }
    // Confirm evidence = the last GEN-VALID co-sample BEFORE this tick (when an
    // expiry resolves, this tick sits at/after the deadline — outside the window).
    const genEvidenceAtMs = this.lastSampleAtMs;
    if (genValid) {
      this.lastSampleAtMs = nowMs;
      this.lastGenerationW = generationW;
    }
    // Order matters. (1) An expiry is resolved (with the pre-tick evidence)
    // before this tick's net can refute — the window closed at its own deadline,
    // not at whatever later tick happened to observe it. (2) The rising lift
    // EDGE opens the window BEFORE the import latch runs, so a boost that engages
    // and then imports on this very first post-engage tick (the heater starting
    // between 10 s polls) opens a window the net channel then REFUTES — otherwise
    // the latch would null the term, no window would open, and the false
    // inference would escape the hold ladder. (3) The net channel then applies
    // the latch / in-window refute against the (possibly just-opened) window.
    this.resolveVerifyWindowExpiry(nowMs, genEvidenceAtMs);
    // Whether a window was already open BEFORE this tick's rising edge could open
    // one — gates the absorption-evidence accumulation below so the engage tick's
    // own pre-draw net does not count as proof the lift was absorbed.
    const windowWasOpen = this.verifyWindowUntilMs !== undefined;
    this.trackLiftEdges(nowMs);
    this.trackNetChannel(netW / 1000, nowMs, windowWasOpen);
    this.logTermStateTransition(nowMs);
  }

  /**
   * The inferred curtailed-surplus term (kW, >= 0), or `null` when it cannot be
   * trusted: dormant, stale co-sample, battery home, refuted-hold, import latch,
   * or no resolvable potential for the current hour. Consumers fold null as 0.
   */
  getCurtailedSurplusKw(nowMs: number): number | null {
    if (!isFiniteNumber(nowMs) || this.dormant) return null;
    if (this.lastSampleAtMs === null || nowMs - this.lastSampleAtMs > CURTAIL_SAMPLE_FRESH_MS) return null;
    if (this.deps.hasHomeBattery()) return null;
    if (this.holdUntilMs !== undefined && nowMs < this.holdUntilMs) return null;
    if (this.importLatchUntilMs !== undefined && nowMs < this.importLatchUntilMs) return null;
    const hourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const potential = this.deps.getPotential(hourStartMs);
    if (potential === null || !isFiniteNumber(potential.kw)) return null;
    const discount = potential.confidence === 'low'
      ? CURTAIL_POTENTIAL_DISCOUNT_LOW_CONF
      : CURTAIL_POTENTIAL_DISCOUNT;
    const generationKw = (this.lastGenerationW ?? 0) / 1000;
    return Math.max(0, discount * potential.kw - generationKw);
  }

  // Close the verify window (any cause) and reset its evidence accumulator.
  private closeVerifyWindow(): void {
    this.verifyWindowUntilMs = undefined;
    this.windowMinNetKw = Number.POSITIVE_INFINITY;
  }

  // A verify window that reached its deadline resolves here. CONFIRMED (ladder
  // reset) needs POSITIVE evidence, not merely the absence of a refute:
  // (a) OBSERVED — a gen-valid co-sample landed within a freshness horizon of
  //     the deadline: a sample outage spanning the window must not confirm on
  //     the first post-outage tick (whatever net that tick carries);
  // (b) LOAD-BEARING — the window's minimum net never went below −gate: a lift
  //     financed by measured export proves nothing about the inferred term, and
  //     confirming it would let a systematically wrong fit park at 15-min holds;
  // (c) ABSORBED — that minimum came down to at most the standing-import
  //     allowance: a window sitting persistently at sub-gate import means the
  //     lift was only partially absorbed.
  // Anything else closes silently with the level kept.
  private resolveVerifyWindowExpiry(nowMs: number, genEvidenceAtMs: number | null): void {
    if (this.verifyWindowUntilMs === undefined || nowMs < this.verifyWindowUntilMs) return;
    const deadline = this.verifyWindowUntilMs;
    const windowMinNetKw = this.windowMinNetKw;
    this.closeVerifyWindow();
    const observedNearDeadline = isFiniteNumber(genEvidenceAtMs)
      && deadline - genEvidenceAtMs <= CURTAIL_SAMPLE_FRESH_MS;
    const loadBearing = windowMinNetKw >= -CURTAIL_NET_GATE_KW;
    const absorbed = windowMinNetKw <= CURTAIL_CONFIRM_STANDING_IMPORT_KW;
    if (!observedNearDeadline || !loadBearing || !absorbed) return;
    if (this.level !== 0) {
      this.level = 0;
      this.persistHoldState();
    }
    this.deps.logger.info({ event: 'curtailment_verify_confirmed' });
  }

  // The NET channel: window-min evidence tracking + the sticky import latch +
  // the in-window refute. Every gate-exceeding tick re-extends the latch, so the
  // term stays zero until the home has been clear of import for a full
  // hold-down — settle can provably never accumulate during import. Runs on
  // every finite net sample, gen-valid or not. `windowWasOpen` is whether a
  // window was already open BEFORE this tick's rising edge: absorption evidence
  // accumulates only for samples strictly AFTER the window opened — the engage
  // tick's own net is pre-draw (~0 before the just-raised device ramps) and must
  // not falsely prove the lift was absorbed. The REFUTE check below still fires
  // on the opening tick, so a boost that engages and immediately imports is
  // caught (fix: rising edge opens before the latch).
  private trackNetChannel(netKw: number, nowMs: number, windowWasOpen: boolean): void {
    if (this.verifyWindowUntilMs !== undefined && windowWasOpen) {
      this.windowMinNetKw = Math.min(this.windowMinNetKw, netKw);
    }
    if (netKw <= CURTAIL_NET_GATE_KW) return;
    const latchWasActive = this.importLatchUntilMs !== undefined && nowMs < this.importLatchUntilMs;
    this.importLatchUntilMs = nowMs + CURTAIL_IMPORT_HOLD_DOWN_MS;
    if (this.verifyWindowUntilMs !== undefined) {
      // REFUTED: the engage forced real grid import inside the verify window.
      // (A concurrent load spike that eats the remaining headroom refutes too —
      // directionally correct: no surplus was actually left; over-punishment is
      // bounded by the first 15-min hold.)
      this.level = Math.min(this.level + 1, CURTAIL_HOLD_MAX_LEVEL);
      const holdMs = CURTAIL_HOLD_BASE_MS * 2 ** (this.level - 1);
      this.holdUntilMs = nowMs + holdMs;
      this.closeVerifyWindow();
      // `holdLevel`, not `level` — pino reserves `level` for the log severity.
      this.deps.logger.info({ event: 'curtailment_verify_refuted', holdLevel: this.level, holdMs });
      this.persistHoldState();
      return;
    }
    // Latch ONSET persists (covers a restart mid-import-episode); the 10 s
    // re-extensions do not — writes stay transition-only, never per tick.
    if (!latchWasActive) this.persistHoldState();
  }

  // Persist the minimal refute-ladder slice on TRANSITIONS only (refute, a
  // level-resetting confirm, latch onset). Best-effort: the adapter absorbs a
  // failed settings write, which merely restores pre-persistence behavior.
  private persistHoldState(): void {
    this.deps.holdStore?.write({
      holdLevel: this.level,
      holdUntilMs: this.holdUntilMs ?? null,
      importLatchUntilMs: this.importLatchUntilMs ?? null,
    });
  }

  // Verify-window lifecycle rides the lift edge: a rising edge while the term is
  // positive (implies: not latched, not holding) opens the window; a falling edge
  // with the window still open closes it silently (no verdict, level kept — the
  // lift released for its own reasons before the outcome resolved).
  private trackLiftEdges(nowMs: number): void {
    const liftEngaged = this.deps.isSurplusLiftEngaged();
    if (liftEngaged && !this.lastLiftEngaged) {
      const termKw = this.getCurtailedSurplusKw(nowMs);
      if (this.verifyWindowUntilMs === undefined && termKw !== null && termKw > 0) {
        this.verifyWindowUntilMs = nowMs + CURTAIL_VERIFY_WINDOW_MS;
        this.deps.logger.info({
          event: 'curtailment_verify_started',
          termKw,
          windowMs: CURTAIL_VERIFY_WINDOW_MS,
        });
      }
    } else if (!liftEngaged && this.lastLiftEngaged && this.verifyWindowUntilMs !== undefined) {
      this.closeVerifyWindow();
    }
    this.lastLiftEngaged = liftEngaged;
  }

  private resolveTermState(nowMs: number): CurtailmentTermState {
    if (this.holdUntilMs !== undefined && nowMs < this.holdUntilMs) return 'hold';
    if (this.importLatchUntilMs !== undefined && nowMs < this.importLatchUntilMs) return 'latched';
    return this.getCurtailedSurplusKw(nowMs) === null ? 'suppressed' : 'armed';
  }

  // Transition-only state record (armed↔suppressed↔latched↔hold) for dogfood
  // tuning — deliberately never per tick (log dedup).
  private logTermStateTransition(nowMs: number): void {
    const state = this.resolveTermState(nowMs);
    if (state === this.lastTermState) return;
    this.deps.logger.info({
      event: 'curtailment_term_state',
      state,
      previousState: this.lastTermState,
      holdLevel: this.level,
    });
    this.lastTermState = state;
  }
}
