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
// - CRASH-LOOP RESILIENCE: the minimal persisted slice ({holdLevel,
//   holdUntilMs, importLatchUntilMs, armed}) persists through the optional injected
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

/**
 * The potential read for one hour. `unresolvable` — no fit yet, no forecast
 * for the hour, or the selected source reporting no confidence — is a named
 * member rather than a nullable potential, so the term fails closed on a state
 * the caller has to discriminate instead of a value it has to null-check.
 */
export type CurtailmentPotentialRead =
  | { kind: 'resolved'; potential: CurtailmentPotential }
  | { kind: 'unresolvable' };

/**
 * The inferred curtailed-surplus term for one instant. `suppressed` — dormant
 * home, stale co-sample, battery home, refuted hold, import latch, or an
 * unresolvable potential for the hour — is the named member the estimator's own
 * `CurtailmentTermState` already spelled, not a nullable kW. It is NOT `0 kW`
 * either: a suppressed term is "no trustworthy surplus reading", while a real
 * `term` of 0 is a measured "nothing spare right now", and both the verify
 * window and the term-state log turn on that difference.
 */
export type CurtailedSurplusRead =
  | { kind: 'term'; kw: number }
  | { kind: 'suppressed' };

/** Minimal structured-log surface (satisfied by the pino logger). */
export type CurtailmentSurplusLogger = {
  info: (obj: Record<string, unknown>) => void;
};

/** The minimal slice that survives a restart: the refute ladder plus the ARMED
 *  latch. Nullable timestamps express "no active hold/latch"; expired values are
 *  harmless (compare false). */
export type CurtailmentPersistedHoldState = {
  holdLevel: number;
  holdUntilMs: number | null;
  importLatchUntilMs: number | null;
  /**
   * Whether this home has EVER delivered a positive co-temporal generation
   * reading — the dormancy latch, which is monotone (armed once, never
   * re-armed), so persisting it is a one-way bit with no re-clear semantics.
   *
   * It must survive a restart because `canContributeSurplus()` is one of the two
   * disjuncts gating the `surplusOnly` posture, and the other one — recorded
   * export — is false BY CONSTRUCTION on the zero-export home this estimator
   * exists to serve. In-memory, a restart after dark would leave both false
   * until the next sunrise, and an unstamped dump load is not passive: PELS's
   * generic restore lane turns it on from grid headroom. The feature would
   * invert, on grid import, all night, on every app update.
   *
   * Absent on a pre-existing blob (older installs) ⇒ treated as not armed, which
   * costs one production sample to re-earn.
   */
  armed?: boolean;
};

/**
 * One read of the persisted slice. Three specific arms because the caller acts
 * on each differently:
 * - `loaded` — a validated blob was read; adopt it.
 * - `absent` — the store answered and there is GENUINELY nothing usable: an
 *   unset key the key list agrees is unset, or a malformed blob the adapter
 *   condemned (a bad blob must never poison the estimator). A safe fresh
 *   start; absence permits a write.
 * - `unreadable` — the read THREW or was contradicted by the key list, so what
 *   is on disk is UNKNOWN rather than absent. A write is forbidden: treating
 *   an unreadable read as "no state" makes the next transition write a fresh
 *   `holdLevel: 0` over a retained refute ladder, which is a destructive reset
 *   of persisted state on a transient settings failure (root `AGENTS.md`;
 *   `notes/persisted-settings-state.md`).
 */
export type CurtailmentHoldReadResolved =
  | { readonly state: 'loaded'; readonly value: CurtailmentPersistedHoldState }
  | { readonly state: 'absent' };

/** `CurtailmentHoldReadResolved` is named (rather than derived via
 *  `Exclude<...>`) so the adapter's normalization can return exactly the
 *  answered subset: a discriminant rename can then never silently widen that
 *  signature back to the full union. */
export type CurtailmentHoldRead =
  | CurtailmentHoldReadResolved
  | { readonly state: 'unreadable' };

/** Store port for the persisted hold slice. Declared here in the domain; the
 *  setup adapter (`setup/curtailmentHoldStateAdapter.ts`) owns the Homey
 *  settings read/write AND the junk normalization — `read()` hands back a
 *  `loaded` state, `absent` (fresh start), or `unreadable` (transient store
 *  failure), never a partial/malformed value. `write()` reports whether the
 *  value actually landed, so a swallowed failure can be retried rather than
 *  assumed. */
export type CurtailmentHoldStore = {
  read: () => CurtailmentHoldRead;
  write: (state: CurtailmentPersistedHoldState) => boolean;
};

export type CurtailmentSurplusDeps = {
  /** Discounted-potential source for a UTC hour-start; `unresolvable`
   *  (no fit yet / no forecast irradiance for the hour) ⇒ term fail-closed. */
  getPotential: (hourStartMs: number) => CurtailmentPotentialRead;
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
 * State is in-memory (restart re-arms fail-closed) except the persisted slice —
 * the refute ladder and the armed latch — which rehydrates from the optional
 * `holdStore`.
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

  // The boot read failed, so what is on disk is UNKNOWN rather than absent.
  // While true, nothing may be written: the level is provably 0 here (nothing
  // was adopted and no refute has happened — a refute clears this flag), so
  // every write withheld is exactly the blank `holdLevel: 0` that must never
  // overwrite a retained ladder. Cleared by the first read that resolves
  // (loaded or absent), or by first-hand ladder-LEVEL evidence (a refute) —
  // never by a latch onset, whose write carries no ladder evidence. If the
  // store never recovers, the suppression simply lasts the process lifetime
  // and a clean restart rehydrates the untouched blob.
  private holdStateUnresolved = false;

  // Whether the armed latch is known to have reached disk. A swallowed write
  // would otherwise leave the bit set in memory and absent on disk — invisible
  // until the next restart, which is precisely the window it exists to cover.
  private armedPersisted = false;

  // Some part of the in-memory hold slice never reached disk because its
  // edge write failed: a merged import-latch deadline (adoption kept the
  // LATER local one), or suppressed-then-licensed local progress persisted on
  // an ABSENT resolution. Retried at the top of every sample tick — the
  // arming retry cannot carry it: adopting an armed blob quiets that lane
  // (`armedPersisted`), and it is gen-gated anyway, while generation ticks
  // stop at night, exactly when import latches are live. Cleared by any
  // landed write (every write carries the full slice).
  private holdSliceUnpersisted = false;

  constructor(private readonly deps: CurtailmentSurplusDeps) {
    // Rehydrate the refute ladder so a crash-loop cannot reset it. The adapter
    // behind `read()` owns validation: junk is condemned to `absent` (fresh
    // start) and a thrown/contradicted read is `unreadable`; expired timestamps
    // are harmless — every consumer compares them against nowMs.
    this.adoptFromStore();
  }

  // Read the optional store (absent in tests ⇒ purely in-memory) and fold the
  // result into local state.
  private adoptFromStore(): void {
    const store = this.deps.holdStore;
    if (store === undefined) return;
    this.adoptPersisted(store.read());
  }

  /**
   * Fold one store read into local state.
   *
   * The LADDER (level + hold deadline) is adopted wholesale, and adoption only
   * ever runs while the disk is the ONLY ladder evidence: at construction, and
   * on the per-tick retry while the boot read is still unreadable. A refute
   * ends the retry (first-hand ladder evidence clears `holdStateUnresolved`),
   * so a late-resolving read after a local ladder transition is never
   * consulted — the two ladders are never blended, and no merge rule has to
   * guess which of two hold deadlines is the real one.
   *
   * Two facts are deliberately NOT wholesale:
   * - The IMPORT LATCH keeps the LATER of the local and persisted deadlines.
   *   It is a monotone safety hold-down (every gate-exceeding tick re-extends
   *   it), so the later deadline is strictly more conservative — whereas
   *   wholesale adoption would let a recovering read truncate a live latch
   *   earned by an import episode the disk never saw ("not importing at this
   *   instant" is exactly what the sticky latch refuses to trust). No ladder
   *   state is blended by this; an expired persisted deadline loses the
   *   comparison on its own. When the LOCAL deadline wins, the merged state
   *   is persisted once on this edge so the newer deadline reaches disk and
   *   survives a restart inside the remaining hold-down.
   * - The ARMED bit is monotone and independent of the ladder, so a read can
   *   only ever confirm it. When it is ADOPTION (not a local production
   *   sample) that lifts dormancy, the lift baseline is seeded exactly as the
   *   local arming path seeds it, so a lift already engaged beforehand is not
   *   misread as a rising edge that opens a verify window on load the
   *   inference never financed.
   */
  private adoptPersisted(read: CurtailmentHoldRead): void {
    if (read.state === 'unreadable') {
      this.holdStateUnresolved = true;
      return;
    }
    this.holdStateUnresolved = false;
    if (read.state === 'absent') {
      // Absence licenses a write — and local progress may exist whose writes
      // were all suppressed while the disk was unknown (the armed latch, an
      // import-latch onset). Nothing else would carry it: the arming retry is
      // gen-gated (dead at night) and the onset edge has already passed, so a
      // restart before the next gen-valid sample would lose the active
      // hold-down. Persist the slice once on this resolution edge; a write
      // that does not land arms the per-tick retry.
      if (!this.dormant || this.importLatchUntilMs !== undefined) this.persistHoldStateOrRetry();
      return;
    }
    const persisted = read.value;
    if (persisted.armed === true) {
      // Rehydrating the ARMED latch only ever clears dormancy, never re-sets it;
      // the posture gate downstream depends on it surviving an overnight restart
      // (see `CurtailmentPersistedHoldState`).
      if (this.dormant) this.lastLiftEngaged = this.deps.isSurplusLiftEngaged();
      this.dormant = false;
      this.armedPersisted = true;
    }
    this.level = persisted.holdLevel;
    this.holdUntilMs = persisted.holdUntilMs ?? undefined;
    const persistedLatch = persisted.importLatchUntilMs ?? undefined;
    if (persistedLatch !== undefined
      && (this.importLatchUntilMs === undefined || persistedLatch > this.importLatchUntilMs)) {
      this.importLatchUntilMs = persistedLatch;
    } else if (this.importLatchUntilMs !== undefined && this.importLatchUntilMs !== persistedLatch) {
      // The LOCAL deadline won the merge, so the disk still holds the older
      // one — persist the merged state once, on this adoption edge. Nothing
      // else will: adopting an armed blob quiets the arming retry, and later
      // importing ticks see an already-active latch (onset persists are
      // edge-only), so without this write the newer deadline lives only in
      // memory and a restart inside the hold-down would reload the stale one.
      // A write that does not land arms the per-tick retry instead
      // (`holdSliceUnpersisted`).
      this.persistHoldStateOrRetry();
    }
  }

  /**
   * A ladder-LEVEL transition (a refute, a level-resetting confirm) is
   * first-hand evidence: it ends the abandon-grace on an unreadable boot read,
   * because withholding writes any longer would lose real evidence rather than
   * protect anything, and it marks any late-resolving disk read stale (the
   * per-tick retry stops with the flag). A latch ONSET is deliberately NOT
   * ladder evidence — its write carries `holdLevel: 0`, exactly the blank that
   * must never overwrite a retained ladder, so its persist stays suppressed
   * while the disk is unknown (see `trackNetChannel`).
   */
  private noteLadderEvidence(): void {
    this.holdStateUnresolved = false;
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
    // Retry an unreadable boot read HERE, ahead of every transition below, so a
    // recovering store is always adopted before this tick can move the ladder
    // or persist anything. Adoption after a local transition would have to
    // blend two ladders; this ordering means it never has to.
    if (this.holdStateUnresolved) this.adoptFromStore();
    // Retry a slice write that never landed — on every sample tick,
    // gen-valid or not (see `holdSliceUnpersisted`).
    if (this.holdSliceUnpersisted) this.persistHoldState();
    const genValid = isFiniteNumber(generationW);
    if (this.dormant) {
      // Dormancy arming is gen-gated: flow homes (gen undefined) and non-solar
      // homes (gen 0) stay fully inert — no latch churn, no logs.
      if (!genValid || generationW <= 0) return;
      this.dormant = false;
      // Persist the arming immediately — this is a transition, not a per-tick
      // write, and it is the one that must outlive a restart.
      this.persistHoldState();
      // Seed the lift baseline to the CURRENT binding lift state, so a lift
      // already engaged before the home first produced is NOT read as a rising
      // edge on this arming tick (which would open a spurious window on load the
      // inference never financed).
      this.lastLiftEngaged = this.deps.isSurplusLiftEngaged();
    }
    // Retry an arming write that never landed. Normally a no-op — the write
    // succeeds on the arming tick — so this costs nothing except while the
    // settings backend is actually failing, which is exactly when the latch
    // would otherwise be silently lost until the next restart.
    if (genValid && !this.dormant && !this.armedPersisted) this.persistHoldState();
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
   * Whether this estimator can STRUCTURALLY contribute to the surplus pool for
   * this home — not whether it has a term right now.
   *
   * Answers the standing question "could an inferred term ever arrive here?",
   * which is what the `surplusOnly` posture must be gated on
   * (`resolveSurplusPoolReachable`): a device stamped on a pool that can never
   * open is held OFF forever.
   *
   * Only the two PERMANENT suppressors count. `dormant` is the home's own
   * capability latch (lifted once, by the first positive co-temporal generation
   * reading), and a battery home has the term suppressed outright in v1. The
   * transient suppressions `getCurtailedSurplusKw` also applies — stale
   * co-sample, import latch, refute hold, no resolvable potential — are deliberately
   * EXCLUDED: they come and go by the minute, and folding them in would flap a
   * dump load on and off all afternoon.
   */
  canContributeSurplus(): boolean {
    return !this.permanentlySuppressed();
  }

  /**
   * The suppressors that no amount of waiting clears: the home has never shown
   * co-temporal generation, or it has a battery (v1 suppresses the term
   * outright). Shared with `getCurtailedSurplusKw` so the "permanent subset"
   * relationship is structural — a future permanent suppressor added only to the
   * term read would otherwise silently re-open the held-off-forever trap that
   * `canContributeSurplus` exists to keep shut.
   */
  private permanentlySuppressed(): boolean {
    return this.dormant || this.deps.hasHomeBattery();
  }

  /**
   * The inferred curtailed-surplus term (kW, >= 0), or `suppressed` when it
   * cannot be trusted: dormant, stale co-sample, battery home, refuted-hold,
   * import latch, or no resolvable potential for the current hour. A consumer
   * whose own seam needs a number for a suppressed term chooses that itself —
   * this producer never hands one out.
   */
  getCurtailedSurplusKw(nowMs: number): CurtailedSurplusRead {
    const suppressed: CurtailedSurplusRead = { kind: 'suppressed' };
    if (!isFiniteNumber(nowMs)) return suppressed;
    // Dormancy and the battery suppression, shared with `canContributeSurplus`.
    if (this.permanentlySuppressed()) return suppressed;
    if (this.lastSampleAtMs === null || nowMs - this.lastSampleAtMs > CURTAIL_SAMPLE_FRESH_MS) return suppressed;
    if (this.holdUntilMs !== undefined && nowMs < this.holdUntilMs) return suppressed;
    if (this.importLatchUntilMs !== undefined && nowMs < this.importLatchUntilMs) return suppressed;
    const hourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const read = this.deps.getPotential(hourStartMs);
    if (read.kind !== 'resolved' || !isFiniteNumber(read.potential.kw)) return suppressed;
    const { potential } = read;
    const discount = potential.confidence === 'low'
      ? CURTAIL_POTENTIAL_DISCOUNT_LOW_CONF
      : CURTAIL_POTENTIAL_DISCOUNT;
    const generationKw = (this.lastGenerationW ?? 0) / 1000;
    return { kind: 'term', kw: Math.max(0, discount * potential.kw - generationKw) };
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
      this.noteLadderEvidence();
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
      this.noteLadderEvidence();
      this.closeVerifyWindow();
      // `holdLevel`, not `level` — pino reserves `level` for the log severity.
      this.deps.logger.info({ event: 'curtailment_verify_refuted', holdLevel: this.level, holdMs });
      this.persistHoldState();
      return;
    }
    // Latch ONSET persists (covers a restart mid-import-episode); the 10 s
    // re-extensions do not — writes stay transition-only, never per tick.
    // While the boot read is still unreadable this persist is a suppressed
    // no-op: an onset write would stamp `holdLevel: 0` over a possibly
    // retained ladder — the destructive reset the abandon-grace exists to
    // prevent. The in-memory latch still guards the term, and the retained
    // ladder is adopted on the next resolving read.
    if (!latchWasActive) this.persistHoldState();
  }

  // Persist the current slice on an edge where nothing else would carry it;
  // a write that does not land arms the per-tick retry
  // (`holdSliceUnpersisted`).
  private persistHoldStateOrRetry(): void {
    if (!this.persistHoldState()) this.holdSliceUnpersisted = true;
  }

  // Persist the minimal refute-ladder slice on TRANSITIONS only (refute, a
  // level-resetting confirm, latch onset, arming, the adoption latch merge).
  // Best-effort: the adapter absorbs a failed settings write, which merely
  // restores pre-persistence behavior. Returns whether the slice actually
  // LANDED; any landed write also clears the slice retry flag, since every
  // write carries the full current slice.
  private persistHoldState(): boolean {
    // Disk unknown ⇒ suppressed for as long as that lasts (possibly the whole
    // process): see `holdStateUnresolved` — every write withheld here carries
    // `holdLevel: 0`, the blank that must never overwrite a retained ladder.
    if (this.holdStateUnresolved) return false;
    const store = this.deps.holdStore;
    // No store configured (tests) means nothing can land: the gen-gated
    // arming retry then no-ops here forever, which is the cheap steady state.
    if (store === undefined) return false;
    const landed = store.write({
      holdLevel: this.level,
      holdUntilMs: this.holdUntilMs ?? null,
      importLatchUntilMs: this.importLatchUntilMs ?? null,
      armed: !this.dormant,
    });
    if (landed) {
      this.armedPersisted = !this.dormant;
      this.holdSliceUnpersisted = false;
    }
    return landed;
  }

  // Verify-window lifecycle rides the lift edge: a rising edge while the term is
  // positive (implies: not latched, not holding) opens the window; a falling edge
  // with the window still open closes it silently (no verdict, level kept — the
  // lift released for its own reasons before the outcome resolved).
  private trackLiftEdges(nowMs: number): void {
    const liftEngaged = this.deps.isSurplusLiftEngaged();
    if (liftEngaged && !this.lastLiftEngaged) {
      const term = this.getCurtailedSurplusKw(nowMs);
      if (this.verifyWindowUntilMs === undefined && term.kind === 'term' && term.kw > 0) {
        this.verifyWindowUntilMs = nowMs + CURTAIL_VERIFY_WINDOW_MS;
        this.deps.logger.info({
          event: 'curtailment_verify_started',
          termKw: term.kw,
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
    return this.getCurtailedSurplusKw(nowMs).kind === 'suppressed' ? 'suppressed' : 'armed';
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
