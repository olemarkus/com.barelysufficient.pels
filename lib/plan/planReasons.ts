import type { DevicePlanDevice } from './planTypes';
import {
  PLAN_REASON_CODES,
  resolveRestoreShortfallKw,
  type DeviceReason,
  type PlanReasonCode,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { computeBaseRestoreNeed } from './restore/accounting';
import {
  classifyPlanReason,
  renderPlanReasonDecision,
  type ClassifiedPlanReason,
  type PlanReasonDecision,
} from './planReasonStrings';
import {
  isBudgetReason,
  isShortfallReason,
  isSwapReason,
  shouldNormalizeReason,
} from './planReasonsShared';
import {
  resolveCeilingShortfall,
  type CeilingShortfallInputs,
} from './planReasonShortfall';
import { isSwapTargetPendingReason } from '../planContract/planDecisionSemantics';

// Public entry point. The shed-temperature hold decision table and the plan
// reason-pair validation live in sibling modules; they are re-exported here so
// importers keep a single `./planReasons` entry point.
export { applyShedTemperatureHold } from './planReasonsHoldDecisions';
export { finalizePlanDevices } from './planReasonsValidation';

// The two standing-hold framing inputs `normalizeShedReasons` consumes (the
// smart-task avoid set + the surplus dump-load hold reasons), bundled so the
// builder can thread them as one value.
export type ShedReasonHoldInputs = {
  deferredObjectiveAvoidDeviceIds: ReadonlySet<string>;
  surplusHoldReasonById: ReadonlyMap<string, DeviceReason>;
};

function buildBaseReason(ctx: ReasonContext, dev: DevicePlanDevice): DeviceReason {
  const { shedReasons } = ctx;
  const classifiedReason = classifyPlanReason(dev.reason);
  const keepReason = shouldNormalizeReason(classifiedReason) ? null : classifiedReason.reason;
  const resolved = shedReasons.get(dev.id) ?? keepReason ?? { code: PLAN_REASON_CODES.capacity };
  // Shared fold with `normalizeDeviceReason` — the full rationale (carry-forward
  // capacity, budget-bound restore holds, the prod-2026-07-25 breach carve-out)
  // lives on `resolveDailyBindingReattribution`.
  const reattributed = resolveDailyBindingReattribution(
    ctx,
    resolved.code,
    resolveRestoreShortfallKw(resolved),
    shedReasons.has(dev.id),
    dev.budgetExempt === true,
  );
  return reattributed ?? resolved;
}

/**
 * The cycle's explanation facts — everything a device reason is normalized
 * against, resolved once by the producer and read by every stage of the pass.
 *
 * Each field was previously re-declared inline on up to five signatures:
 * `normalizeShedReasons` declared sixteen members and forwarded fourteen of
 * them, unread, straight into `normalizeDeviceReason`, which redeclared the
 * same fourteen. Nothing here is optional any more — the defaults that used to
 * sit on those bags existed "so scalar-only callers/tests keep the pre-existing
 * behaviour", which is test-shaped optionality on a production contract.
 */
export type ReasonContext = {
  readonly shedReasons: Map<string, DeviceReason>;
  readonly guardInShortfall: boolean;
  readonly headroomRaw: number;
  readonly inCooldown: boolean;
  readonly activeOvershoot: boolean;
  readonly shedCooldownRemainingSec: number | null;
  readonly shedCooldownStartedAtMs: number | null;
  readonly shedCooldownTotalSec: number | null;
  /**
   * Devices whose active smart task is between planned hours. When such a device
   * ends up held this cycle, that framing wins over capacity/dailyBudget because
   * it reflects the owner's opt-in to the price-aware plan.
   */
  readonly deferredObjectiveAvoidDeviceIds: ReadonlySet<string>;
  /**
   * Devices held OFF by the standing "Run on solar surplus" dump-load posture,
   * with the producer-built stable `awaitingSolarSurplus` reason. Adopted like
   * the deferred-avoid framing: it wins over the capacity/dailyBudget default,
   * but never over a fresh shed decision or the richer shortfall/cooldown/swap
   * reasons.
   */
  readonly surplusHoldReasonById: ReadonlyMap<string, DeviceReason>;
  /** Plan-level binding constraint; `'daily'` re-attributes carried `capacity` reasons. */
  readonly softLimitSource: 'capacity' | 'daily' | null;
  /** Over the CAPACITY soft limit, whichever limit binds. Producer-resolved. */
  readonly capacityBreached: boolean;
  /** Daily pace binding AND capacity not also breached. Producer-resolved. */
  readonly budgetReleasableHeadroomHold: boolean;
  /** The hour's energy budget is spent; folds every ceiling hold to `hourlyBudget`. */
  readonly hourlyBudgetExhausted: boolean;
  /** Post-hold per-axis availability + startup reservations, for ceiling shortfalls. */
  readonly admissionInputs: CeilingShortfallInputs | null;
};

function maybeApplyShortfallReason(
  ctx: ReasonContext,
  dev: DevicePlanDevice,
  currentReason: ClassifiedPlanReason,
): PlanReasonDecision | null {
  const { guardInShortfall, headroomRaw } = ctx;
  if (!guardInShortfall || isSwapReason(currentReason) || isBudgetReason(currentReason)) return null;
  if (currentReason.code === PLAN_REASON_CODES.neutralStartupHold) return null;
  if (isShortfallReason(currentReason)) return null;
  const { needed: estimatedNeed } = computeBaseRestoreNeed(dev);
  return { code: 'shortfall', neededKw: estimatedNeed, headroomKw: headroomRaw };
}

function maybeApplyCooldownReason(
  ctx: ReasonContext,
  currentReason: ClassifiedPlanReason,
): PlanReasonDecision | null {
  const {
    inCooldown, activeOvershoot, shedCooldownRemainingSec,
    shedCooldownStartedAtMs, shedCooldownTotalSec,
  } = ctx;
  if (
    inCooldown
    && !activeOvershoot
    && !isSwapReason(currentReason)
    && currentReason.code !== PLAN_REASON_CODES.neutralStartupHold
    // A startup reservation is why this device is not resuming; the shed cooldown is incidental
    // (it fires whenever ANY device was shed in the last 60 s). Same precedent as the surplus
    // hold above — without this the card flips to "will try to resume in Ns" and hides the cause.
    && currentReason.code !== PLAN_REASON_CODES.reservedForStart
    // Same shape, and the ladder both stay-off lanes run (`resolveOffDeviceReason`,
    // `restore/devices.ts`) already ranks startup stabilization ABOVE the shed cooldown.
    // Without this the normalizer silently re-ranked them the other way, so a device the
    // lanes had just labelled `startupStabilization` read `cooldown_shedding` for any boot
    // where some device happened to be shed inside the last 60 s.
    && currentReason.code !== PLAN_REASON_CODES.startupStabilization
  ) {
    return {
      code: 'cooldown_shedding',
      remainingSec: shedCooldownRemainingSec,
      countdownTiming: {
        ...(typeof shedCooldownStartedAtMs === 'number' ? { countdownStartedAtMs: shedCooldownStartedAtMs } : {}),
        ...(typeof shedCooldownTotalSec === 'number' && shedCooldownTotalSec > 0
          ? { countdownTotalSec: shedCooldownTotalSec }
          : {}),
      },
    };
  }
  return null;
}

export function normalizeShedReasons(
  planDevices: DevicePlanDevice[],
  ctx: ReasonContext,
): DevicePlanDevice[] {

  return planDevices.map((dev) => finalizeCeilingReason(
    ctx,
    normalizeDeviceReason(ctx, dev),
    ctx.shedReasons.has(dev.id),
  ));
}

// Reason codes the hourly-exhausted fold rewrites to `hourlyBudget`. Swap
// reasons are deliberately absent — they keep their own framing (which device
// took the power) in the activity log; on the card they render bare during the
// exhausted hour because the shortfall attach is suspended too (below). A
// fresh `hourlyBudget` reason never reaches this set — `resolveHourlyFold`
// early-returns on it to preserve the producer's object identity.
const HOURLY_FOLD_REASON_CODES: ReadonlySet<DeviceReason['code']> = new Set([
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.dailyBudget,
  PLAN_REASON_CODES.insufficientHeadroom,
]);

// Reason codes the uniform per-cycle shortfall attaches to. `insufficientHeadroom`
// self-computes from its own admission margins; `hourlyBudget` never carries a
// kW (time-based copy); `sheddingActive` has no live producer.
const SHORTFALL_ATTACH_REASON_CODES: ReadonlySet<DeviceReason['code']> = new Set([
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.dailyBudget,
  PLAN_REASON_CODES.swapPending,
  PLAN_REASON_CODES.swappedOut,
]);

// Last stage of reason normalization, run on every device after the per-device
// framing above has settled. Closes the "bare Waiting to resume" gap
// (prod 2026-08-02): a ceiling hold whose producer had no admission arithmetic
// in scope — a fresh shed, a carry-forward under active overshoot, a
// temperature-lane hold, a swap victim — now gets THIS device's own
// pace-relative admission gap attached every cycle, so the card can always say
// what the device needs.
//
// Freshness wins over producer numbers on the attach-set codes: a
// producer-resolved kW is a snapshot of the rejection that minted it, and the
// carry-forward states (cooldowns, active overshoot) keep it on the card while
// the pace moves — prod 2026-08-02 evening: cards read "2.3 kW more needed"
// minted at a transient −0.34 kW overshoot dip, while the recovered pace put
// the true gap at 1.3 kW. Recomputing every cycle trades the producer's extra
// detail (swap-reserve fold, penalty inflation — up to ~0.3 kW) for a number
// that is never minutes old; the producer figure survives only where the
// per-axis inputs are absent (direct-call tests). `insufficientHeadroom`
// reasons keep self-computing from their own margins — under daily binding the
// re-attribution above converts them to `dailyBudget` each cycle, which lands
// them back in the attach set and refreshes the number.
//
// During the exhausted hour no kW is attached to ANY code (and any carried one
// is stripped): spent kWh cannot be un-spent, so a gap figure would be
// dishonest until the hour rolls over — the same rule that gives `hourlyBudget`
// its time-based copy. Swap holds keep their framing and simply render bare.
function finalizeCeilingReason(
  ctx: ReasonContext,
  dev: DevicePlanDevice,
  shedReasonFresh: boolean,
): DevicePlanDevice {
  const { admissionInputs, hourlyBudgetExhausted } = ctx;
  if (dev.plannedState !== 'shed') return dev;
  const withReason = (reason: DeviceReason): DevicePlanDevice => (
    reason === dev.reason ? dev : { ...dev, reason }
  );

  const folded = resolveHourlyFold(ctx, dev, shedReasonFresh);
  if (hourlyBudgetExhausted || folded.code === PLAN_REASON_CODES.hourlyBudget) {
    return withReason(stripCycleAnnotations(folded));
  }

  if (!admissionInputs || !SHORTFALL_ATTACH_REASON_CODES.has(folded.code)) {
    return withReason(folded);
  }
  // A pending swap TARGET (`swapPending`, target unresolved) already has its
  // relief committed: its selected sources are `plannedState: 'shed'` and mid
  // turn-off, so they are absent from the swap surface and the computed gap
  // would state the full plain deficit that the in-flight swap is about to
  // cover. No number is honest for the one or two cycles this shape lives.
  //
  // MUST stay ABOVE the attach below. This return does not strip, so it is safe
  // only because nothing can have annotated this shape yet — the guard runs
  // first, so a null-target `swapPending` never acquires a `reserveHolderName`
  // to go stale. Move it below the attach and the carried-holder bug this
  // function strips for everywhere else reappears here alone.
  if (isSwapTargetPendingReason(folded)) return withReason(folded);
  const resolution = resolveCeilingShortfall({ dev, inputs: admissionInputs });
  // Admission declined ONLY because the power is promised to a device about to
  // start. No kW is honest (the gap would be the HOLDER's quantity), but the
  // holder's name is — so the card can say who, instead of falling to the bare
  // waiting line. The reason CODE deliberately does not change to
  // `reservedForStart`: that code builds no actuation intent, and this stage
  // cannot tell a materialized shed from an in-flight one. See `ReserveHolder`
  // in `planReasonSemanticsCore.ts` for the full account.
  if (resolution.kind === 'blocked_by_reserve') {
    return withReason(attachReserveHolder(stripCycleAnnotations(folded), resolution.holderName));
  }
  if (resolution.kind === 'no_gap') return withReason(stripCycleAnnotations(folded));
  return withReason(attachShortfall(stripCycleAnnotations(folded), resolution.shortfallKw));
}

// Inverse of BOTH attach helpers: the per-cycle display annotations a ceiling
// hold may carry. Neither may outlive the arithmetic that produced it — a
// `shortfallKw` minted at an earlier rejection would pin a stale number on the
// card while the pace moves, and a `reserveHolderName` from a reserve-blocked
// cycle would keep saying "Waiting so X can start" after X's reservation ended,
// hiding the kW the current cycle actually resolved (the card ladder reads the
// holder first, as the more specific cause).
//
// Stripping BOTH on every path, then re-attaching at most one, is what makes
// their mutual exclusivity structural instead of a convention two branches have
// to remember.
//
// Object identity is preserved when there is nothing to drop: `withReason`
// compares against `dev.reason` to avoid minting a new object, and reason
// byte-stability is what keeps a rebuild storm from re-emitting an unchanged
// plan (`awaitingSolarSurplus` in `planReasonSemanticsCore.ts`, f1550cea).
function stripCycleAnnotations(reason: DeviceReason): DeviceReason {
  const hasShortfall = 'shortfallKw' in reason && reason.shortfallKw !== undefined;
  const hasHolder = 'reserveHolderName' in reason && reason.reserveHolderName !== undefined;
  if (!hasShortfall && !hasHolder) return reason;
  const { shortfallKw: _kw, reserveHolderName: _holder, ...rest } = reason as DeviceReason & {
    shortfallKw?: number;
    reserveHolderName?: string;
  };
  return rest;
}

// The hourly-exhausted fold and its inverse. Forward: while the hour's kWh is
// spent, every ceiling hold reads `hourlyBudget` (time-based copy — spent kWh
// cannot be un-spent, so a kW would be dishonest). Inverse: once the hour rolls
// over, a carried-forward `hourlyBudget` reason must be re-attributed to the
// currently binding ceiling — nothing else rewrites it (it is not in
// `shouldNormalizeReason` and the restore lane carries reasons forward under
// overshoot), so without this the "next hour" line would outlive the hour it
// described. The re-attribution mirrors `resolveShedReason`/
// `resolveDailyBindingReattribution` semantics: daily only when it binds
// without a capacity breach, and never for a budget-exempt device (its holds
// are capacity holds by per-axis admission). A fresh-this-cycle `shedReasons`
// entry is left alone, same as the daily re-attribution: the selector set it
// with the current cycle's facts.
function resolveHourlyFold(
  ctx: ReasonContext,
  dev: DevicePlanDevice,
  shedReasonFresh: boolean,
): DeviceReason {
  const { hourlyBudgetExhausted, softLimitSource, capacityBreached } = ctx;
  if (hourlyBudgetExhausted) {
    if (dev.reason.code === PLAN_REASON_CODES.hourlyBudget) return dev.reason;
    if (HOURLY_FOLD_REASON_CODES.has(dev.reason.code)) {
      return { code: PLAN_REASON_CODES.hourlyBudget };
    }
    return dev.reason;
  }
  if (dev.reason.code !== PLAN_REASON_CODES.hourlyBudget) return dev.reason;
  if (shedReasonFresh) return dev.reason;
  const daily = softLimitSource === 'daily' && !capacityBreached && dev.budgetExempt !== true;
  return daily
    ? { code: PLAN_REASON_CODES.dailyBudget }
    : { code: PLAN_REASON_CODES.capacity };
}

// Sibling of `attachShortfall` for the reserve carve-out. Same four carrier
// variants, same per-variant narrowing, and the same display-only contract — the
// two fields are mutually exclusive because the branch that attaches this one is
// precisely the branch where no gap figure exists.
function attachReserveHolder(reason: DeviceReason, reserveHolderName: string): DeviceReason {
  switch (reason.code) {
    case PLAN_REASON_CODES.capacity:
    case PLAN_REASON_CODES.dailyBudget:
      return { ...reason, reserveHolderName };
    case PLAN_REASON_CODES.swapPending:
    case PLAN_REASON_CODES.swappedOut:
      return { ...reason, reserveHolderName };
    default:
      return reason;
  }
}

// Per-variant narrowing for the spread — the union type only accepts
// `shortfallKw` inside the carrier variants.
function attachShortfall(reason: DeviceReason, shortfallKw: number): DeviceReason {
  switch (reason.code) {
    case PLAN_REASON_CODES.capacity:
    case PLAN_REASON_CODES.dailyBudget:
      return { ...reason, shortfallKw };
    case PLAN_REASON_CODES.swapPending:
    case PLAN_REASON_CODES.swappedOut:
      return { ...reason, shortfallKw };
    default:
      return reason;
  }
}

function normalizeDeviceReason(ctx: ReasonContext, dev: DevicePlanDevice): DevicePlanDevice {
  const { shedReasons, deferredObjectiveAvoidDeviceIds } = ctx;

  if (dev.plannedState !== 'shed') return dev;

  const currentReason = classifyPlanReason(dev.reason);
  const baseReason = buildBaseReason(ctx, dev);

  const shortfallReason = maybeApplyShortfallReason(ctx, dev, currentReason);
  if (shortfallReason) return { ...dev, reason: renderPlanReasonDecision(shortfallReason) };

  // Surplus-hold framing takes precedence over the plan-wide shed cooldown for a
  // device whose shed IS the standing "Run on solar surplus" posture: the device
  // is held for surplus, not for the cooldown (which is incidental — it fires
  // whenever ANY device was recently shed). This must run BEFORE the cooldown
  // return below, or a surplus-held dump load would show `cooldown_shedding`
  // during the 60 s window — and, worse, the stepped-restore-block invariant
  // (`isSurplusOnlyHoldShed`, keyed on `reason.code === awaitingSolarSurplus`)
  // would then NOT exempt it, so it would wrongly count as capacity pressure and
  // block unrelated stepped restores. `resolveSurplusHoldReasonAdoption` fires
  // ONLY for a genuine surplus hold (device in `surplusHoldReasonById`, no fresh
  // `shedReasons` entry), so a device genuinely in a capacity cooldown still
  // falls through to `cooldown_shedding` below.
  const surplusHoldReason = resolveSurplusHoldReasonAdoption(ctx, dev, currentReason);
  if (surplusHoldReason) return { ...dev, reason: surplusHoldReason };

  const cooldownReason = maybeApplyCooldownReason(ctx, currentReason);
  if (cooldownReason) return { ...dev, reason: renderPlanReasonDecision(cooldownReason) };

  // Smart-task framing wins over capacity / dailyBudget framing when both
  // apply: the user opted into the price-aware plan, so "Waiting for cheaper
  // hours" reflects the planner's intent more honestly than naming whichever
  // physical constraint happens to be binding right now. Skipped when the
  // device has a richer hold reason (shortfall above, swap/budget below) —
  // those carry user-actionable information the smart-task framing would
  // hide. Active state-machine reasons (cooldown handled above) similarly
  // pass through.
  if (deferredObjectiveAvoidDeviceIds?.has(dev.id) && shouldAdoptDeferredAvoidFraming(currentReason, baseReason)) {
    return { ...dev, reason: { code: PLAN_REASON_CODES.deferredObjectiveAvoid } };
  }

  const dailyReattribution = resolveDailyBindingReattribution(
    ctx,
    currentReason.code,
    resolveRestoreShortfallKw(currentReason.reason),
    shedReasons.has(dev.id),
    dev.budgetExempt === true,
  );
  if (dailyReattribution) return { ...dev, reason: dailyReattribution };

  if (shouldNormalizeReason(currentReason)) {
    return { ...dev, reason: baseReason };
  }
  return dev;
}

// Re-attribution to `dailyBudget` while the daily-budget pacing is the binding
// constraint. Shared by `buildBaseReason` (carry-forward path) and
// `normalizeDeviceReason` (explicit-reason path) so the two sites cannot drift —
// the removed inline copies had already needed one guard-mirroring fix each.
// Two shapes:
//
// - Carry-forward `capacity` reasons: a device shed in an earlier cycle (capacity
//   binding) keeps a stale capacity reason after `softLimitSource` flips to daily —
//   without this the card reads "Limited by the hard cap" while the hero safe-pace
//   number is the daily-budget pacing. A fresh-this-cycle `shedReasons` entry is
//   left alone — the shedding selector set it with the already-correct source.
//   Guarded by `!capacityBreached`: `softLimitSource` names the BINDING (lower)
//   limit, not the one the draw has crossed; when total is over the capacity limit
//   too, capacity is the constraint doing the work and the daily budget is not a
//   lever that can help. Prod 2026-07-25: a budget-exempt EV charger — shed only
//   because a real breach overrode its exemption — read "Limited by today's daily
//   budget" next to its own "Budget exempt" chip, with a "Let it run now" release that
//   could not create capacity headroom. Budget-exempt devices are excluded
//   below: since per-axis restore admission, an exempt candidate is evaluated
//   on the capacity axis, so its holds are never budget holds.
//
// - `insufficientHeadroom` restore holds: a restore rejected on headroom while the
//   DAILY pace is binding is a budget hold, not a power shortage — `availableKw`
//   was derived from the budget-derived pace, so no amount of freed power changes
//   the decision; only budget pacing (or time) does. Without this fold every
//   budget-bound hold surfaces as `insufficientHeadroom` and the hero's "to stay
//   within today's budget" sentence can never fire. Gated on
//   `budgetReleasableHeadroomHold`, the producer-resolved flat semantic on
//   `PlanContext` that `planDiagnostics` also reads, so the card label and the
//   rescue widget agree by construction.
//
//   The fold re-labels the hold; it does NOT drop its numbers. `sourceShortfallKw`
//   carries the admission shortfall onto the re-attributed reason so the device
//   card can still say what the device NEEDS. Until 2026-08-02 the number was
//   discarded here, deliberately: the displayed gap was `need − available`, which
//   ignored the reserve stack and produced absurdities (prod 2026-08-01: 12
//   devices, house at 0.6 kW, gaps up to 5.2 kW against a 5.0 kW hard cap). That
//   arithmetic was fixed (`resolveRestoreShortfallKw` now computes the gap
//   admission actually gates on), so the number is trustworthy and belongs on the
//   card — WHICH ceiling is binding is a house-level fact the hero states once.
//   `sourceShortfallKw` is still `null` whenever the restore lane never evaluated
//   the device (fresh shed, skipped pass, temperature-lane hold); that gap is
//   closed downstream by `finalizeCeilingReason`, which computes the device's own
//   admission gap every cycle when no producer number exists.
//
// Note on `DEFERRED_RESTORE_BLOCK_REASON_CODES`
// (`lib/planContract/planDecisionSemantics.ts`): `dailyBudget` is absent from that
// set, but the coupling is LATENT today — `buildExecutableReleaseIntent` requires
// `plannedState === 'keep'` before it consults the reason, and every re-attributed
// hold is a shed device, so a smart-task binary_restore cannot lift these holds
// through this fold. Pinned in `test/unit/planDecisionSemantics.test.ts`; if
// budget holds ever ride keep-state devices, revisit that set deliberately.
function resolveDailyBindingReattribution(
  ctx: ReasonContext,
  reasonCode: PlanReasonCode,
  sourceShortfallKw: number | null,
  shedReasonFresh: boolean,
  budgetExempt: boolean,
): DeviceReason | null {
  const { softLimitSource, capacityBreached, budgetReleasableHeadroomHold } = ctx;
  if (softLimitSource !== 'daily' || capacityBreached) return null;
  // Never fold a budget-exempt device's hold to `dailyBudget`: per-axis restore
  // admission evaluates exempt candidates on the CAPACITY axis, so their holds
  // are capacity holds, and the budget rescue ("Let it run now") is a no-op for
  // a device that is already exempt — the wrong-lever symptom class this fold
  // exists to prevent. (This inverts the pre-per-axis comment that admission
  // had "no exemption carve-out"; it does now.)
  if (budgetExempt) return null;
  const reattribute = (reasonCode === PLAN_REASON_CODES.capacity && !shedReasonFresh)
    || (reasonCode === PLAN_REASON_CODES.insufficientHeadroom && budgetReleasableHeadroomHold);
  if (!reattribute) return null;
  // Absence is the missing KEY, not a `null` value: `shortfallKw` is `?: number`
  // and `stripCycleAnnotations` expresses "no number this cycle" by deleting it.
  return {
    code: PLAN_REASON_CODES.dailyBudget,
    ...(sourceShortfallKw === null ? {} : { shortfallKw: sourceShortfallKw }),
  };
}

// Surplus dump-load framing: a device the standing "Run on solar surplus" hold
// kept off this cycle reads "Waiting for solar surplus" instead of the misleading
// capacity/dailyBudget default (its baseline is off by opt-in, not by pressure).
// A device in `surplusHoldReasonById` is DEFINITIONALLY a surplus hold this cycle
// (resolveSurplusHold selected it), so its shed IS the standing posture and the
// surplus framing overrides the incidental transient framings — the plan-wide shed
// cooldown (finding A on #1817), the capacity/dailyBudget carry-forward, and keep.
// Two things still win:
//   - a FRESH shed decision this cycle (`shedReasons` — a genuinely capacity/budget-
//     shed dump load, e.g. one that was running then shed): real pressure the user
//     should see, AND the discriminator the stepped-restore-block invariant relies
//     on (`isSurplusOnlyHoldShed` keys on `reason.code === awaitingSolarSurplus`);
//   - a swap reason (the device is being swapped for a higher-priority load): richer
//     user-actionable info. (Shortfall already returned in the caller before this.)
// The adopted reason is producer-built and stable across cycles (no numbers).
function resolveSurplusHoldReasonAdoption(
  ctx: ReasonContext,
  dev: DevicePlanDevice,
  currentReason: ClassifiedPlanReason,
): DeviceReason | null {
  const reason = ctx.surplusHoldReasonById.get(dev.id);
  if (!reason) return null;
  if (ctx.shedReasons.has(dev.id)) return null;
  if (isSwapReason(currentReason)) return null;
  return reason;
}

// Only override capacity-shaped reasons with the smart-task framing. Swap,
// shortfall, hourlyBudget, dailyBudget, inactive, and the various
// state-machine reasons (`sheddingActive`, etc.) all carry information the
// `deferredObjectiveAvoid` framing would hide, so we leave them alone.
function shouldAdoptDeferredAvoidFraming(
  currentReason: ClassifiedPlanReason,
  baseReason: DeviceReason,
): boolean {
  if (isSwapReason(currentReason) || isShortfallReason(currentReason)) return false;
  if (currentReason.code === PLAN_REASON_CODES.hourlyBudget) return false;
  if (currentReason.code === PLAN_REASON_CODES.dailyBudget) return true;
  if (currentReason.code === PLAN_REASON_CODES.capacity) return true;
  // Reason will normalize to the base reason this cycle — override when the
  // base is capacity- or dailyBudget-shaped.
  return baseReason.code === PLAN_REASON_CODES.capacity
    || baseReason.code === PLAN_REASON_CODES.dailyBudget;
}
