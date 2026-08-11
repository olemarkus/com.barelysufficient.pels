import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from './planReasonSemanticsCore';
import {
  PLAN_STATE_AWAITING_SOLAR_SURPLUS_STATUS,
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
  PLAN_STATE_DAILY_BUDGET_STATUS,
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_CAPACITY_STATUS,
  PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS,
  formatReservedForStartStatus,
} from './planStateLabels';
import { formatStepDisplayLabel } from './steppedStepLabel';

// The two reasons that still carry free text. The five ceiling/hold codes that
// used to sit here (`hourlyBudget`, `dailyBudget`, `capacity`,
// `deferredObjectiveAvoid`, `awaitingSolarSurplus`) lost their `detail` slot:
// every producer passed `null`, so their text is fixed and they now render from
// the static group below.
type DetailReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.keep }
  | { code: typeof PLAN_REASON_CODES.inactive }
>;

type TimedReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.cooldownShedding }
  | { code: typeof PLAN_REASON_CODES.cooldownRestore }
  | { code: typeof PLAN_REASON_CODES.meterSettling }
  | { code: typeof PLAN_REASON_CODES.activationBackoff }
  | { code: typeof PLAN_REASON_CODES.restorePending }
>;

// Reasons whose whole text is fixed by the code. `dailyBudget`/`capacity` still
// carry the per-cycle `shortfallKw`/`reserveHolderName` annotations, but neither
// appears in this text — the card ladder reads them directly
// (`planCardReasonLine.ts`).
type StaticReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.restoreThrottled }
  | { code: typeof PLAN_REASON_CODES.waitingForOtherDevices }
  | { code: typeof PLAN_REASON_CODES.externalOffHold }
  | { code: typeof PLAN_REASON_CODES.neutralStartupHold }
  | { code: typeof PLAN_REASON_CODES.startupStabilization }
  | { code: typeof PLAN_REASON_CODES.capacityControlOff }
  | { code: typeof PLAN_REASON_CODES.hourlyBudget }
  | { code: typeof PLAN_REASON_CODES.dailyBudget }
  | { code: typeof PLAN_REASON_CODES.capacity }
  | { code: typeof PLAN_REASON_CODES.deferredObjectiveAvoid }
  | { code: typeof PLAN_REASON_CODES.awaitingSolarSurplus }
>;

function formatSignedKw(value: number, digits: number): string {
  const factor = 10 ** digits;
  const epsilonAdjusted = value >= 0 ? value + Number.EPSILON : value - Number.EPSILON;
  return (Math.round(epsilonAdjusted * factor) / factor).toFixed(digits);
}

function formatRemainingSec(remainingSec: number): number {
  return Math.max(0, Math.trunc(remainingSec));
}

const STATIC_REASON_CODES = new Set<string>([
  PLAN_REASON_CODES.restoreThrottled,
  PLAN_REASON_CODES.waitingForOtherDevices,
  PLAN_REASON_CODES.externalOffHold,
  PLAN_REASON_CODES.neutralStartupHold,
  PLAN_REASON_CODES.startupStabilization,
  PLAN_REASON_CODES.capacityControlOff,
  PLAN_REASON_CODES.hourlyBudget,
  PLAN_REASON_CODES.dailyBudget,
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.deferredObjectiveAvoid,
  PLAN_REASON_CODES.awaitingSolarSurplus,
]);

function isStaticReason(reason: DeviceReason): reason is StaticReason {
  return STATIC_REASON_CODES.has(reason.code);
}

function formatStaticReason(reason: StaticReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.restoreThrottled:
      return 'restore throttled';
    case PLAN_REASON_CODES.waitingForOtherDevices:
      return 'waiting for other devices to recover';
    case PLAN_REASON_CODES.externalOffHold:
      return 'staying off until turned on again';
    case PLAN_REASON_CODES.neutralStartupHold:
      return 'left off';
    case PLAN_REASON_CODES.startupStabilization:
      return 'startup stabilization';
    case PLAN_REASON_CODES.capacityControlOff:
      return 'capacity control off';
    case PLAN_REASON_CODES.hourlyBudget:
      return 'shed due to hourly budget';
    case PLAN_REASON_CODES.dailyBudget:
      return 'shed due to daily budget';
    case PLAN_REASON_CODES.capacity:
      return 'shed due to capacity';
    case PLAN_REASON_CODES.deferredObjectiveAvoid:
      return 'waiting for cheaper hours';
    case PLAN_REASON_CODES.awaitingSolarSurplus:
      return 'waiting for solar surplus';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function isDetailReason(reason: DeviceReason): reason is DetailReason {
  return reason.code === PLAN_REASON_CODES.keep
    || reason.code === PLAN_REASON_CODES.inactive;
}

function formatDetailReason(reason: DetailReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.keep:
      return reason.detail ? `keep (${reason.detail})` : 'keep';
    case PLAN_REASON_CODES.inactive:
      return `inactive (${reason.detail})`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function isTimedReason(reason: DeviceReason): reason is TimedReason {
  return reason.code === PLAN_REASON_CODES.cooldownShedding
    || reason.code === PLAN_REASON_CODES.cooldownRestore
    || reason.code === PLAN_REASON_CODES.meterSettling
    || reason.code === PLAN_REASON_CODES.activationBackoff
    || reason.code === PLAN_REASON_CODES.restorePending;
}

function formatTimedReason(reason: TimedReason): string {
  const remainingSec = formatRemainingSec(reason.remainingSec);
  switch (reason.code) {
    case PLAN_REASON_CODES.cooldownShedding:
      return `cooldown (shedding, ${remainingSec}s remaining)`;
    case PLAN_REASON_CODES.cooldownRestore:
      return `cooldown (restore, ${remainingSec}s remaining)`;
    case PLAN_REASON_CODES.meterSettling:
      return `meter settling (${remainingSec}s remaining)`;
    case PLAN_REASON_CODES.activationBackoff:
      return `activation backoff (${remainingSec}s remaining)`;
    case PLAN_REASON_CODES.restorePending:
      return `restore pending (${remainingSec}s remaining)`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatRestoreNeed(reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.restoreNeed }>): string {
  return `restore ${reason.fromTarget} -> ${reason.toTarget} (need ${formatSignedKw(reason.needKw, 2)}kW)`;
}

function formatShortfall(reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.shortfall }>): string {
  return `shortfall (need ${formatSignedKw(reason.needKw, 2)}kW, `
    + `headroom ${formatSignedKw(reason.headroomKw, 2)}kW)`;
}

function formatNeedSummary(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string {
  const penaltyExtraKw = reason.penaltyExtraKw ?? 0;
  if (penaltyExtraKw > 0) {
    const baseNeedKw = reason.needKw - penaltyExtraKw;
    return `effective need ${formatSignedKw(reason.needKw, 2)}kW `
      + `(base ${formatSignedKw(baseNeedKw, 2)}kW + penalty ${formatSignedKw(penaltyExtraKw, 2)}kW)`;
  }
  return `need ${formatSignedKw(reason.needKw, 2)}kW`;
}

// Null only when the swap path was not in play at all — both fields are set
// together by `buildRestoreHeadroomReason`'s swap callers.
function formatEffectiveSummary(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string | null {
  if (reason.effectiveAvailableKw === null || reason.swapReserveKw === null) return null;
  return `effective ${formatSignedKw(reason.effectiveAvailableKw, 2)}kW after `
    + `${formatSignedKw(reason.swapReserveKw, 2)}kW swap reserve`;
}

function formatPostReserveMarginSummary(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string {
  return `post-reserve margin ${formatSignedKw(reason.postReserveMarginKw, 3)}kW < `
    + `${formatSignedKw(reason.minimumRequiredPostReserveMarginKw, 3)}kW`;
}

function formatInsufficientHeadroom(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string {
  const prefix = 'insufficient headroom to restore';
  const needSummary = formatNeedSummary(reason);
  const availableSummary = `available ${formatSignedKw(reason.availableKw, 2)}kW`;
  const effectiveSummary = formatEffectiveSummary(reason);

  if (effectiveSummary && reason.effectiveAvailableKw !== null && reason.effectiveAvailableKw < reason.needKw) {
    return `${prefix} (${needSummary}, ${availableSummary}, ${effectiveSummary})`;
  }
  // Raw availability already short of the need: the reserve breakdown adds
  // nothing the reader cannot see, so the short form stands.
  if (reason.availableKw < reason.needKw) {
    return `${prefix} (${needSummary}, ${availableSummary})`;
  }
  const reserveSummary = effectiveSummary ? `${effectiveSummary}, ` : '';
  return `${prefix} after reserves `
    + `(${needSummary}, ${availableSummary}, ${reserveSummary}${formatPostReserveMarginSummary(reason)})`;
}

// The three reasons whose whole payload is "who is this for": swap source, swap target, and a
// startup reservation. Grouped so each formatter handles them in one branch instead of three
// switch cases — same shape as the isStaticReason / isDetailReason / isTimedReason groups above.
// Only `swapPending` still admits a missing name — a swap whose target has not
// been resolved yet is a real, load-bearing state (`executableTargetProjection`,
// `planDecisionSemantics`). `swappedOut` and `reservedForStart` always name a
// device, so their fallbacks are gone.
type TargetNameReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.swapPending }
  | { code: typeof PLAN_REASON_CODES.swappedOut }
  | { code: typeof PLAN_REASON_CODES.reservedForStart }
>;

const TARGET_NAME_REASON_CODES = new Set<string>([
  PLAN_REASON_CODES.swapPending,
  PLAN_REASON_CODES.swappedOut,
  PLAN_REASON_CODES.reservedForStart,
]);

const isTargetNameReason = (reason: DeviceReason): reason is TargetNameReason => (
  TARGET_NAME_REASON_CODES.has(reason.code)
);

function formatTargetNameReason(reason: TargetNameReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.swapPending:
      return reason.targetName ? `swap pending (${reason.targetName})` : 'swap pending';
    case PLAN_REASON_CODES.reservedForStart:
      return `startup power reserved for ${reason.targetName}`;
    default:
      return `swapped out for ${reason.targetName}`;
  }
}

function formatTargetNameReasonUserFacing(reason: TargetNameReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.swapPending:
      return reason.targetName
        ? `Making room for higher-priority device (${reason.targetName})`
        : 'Making room for higher-priority device';
    case PLAN_REASON_CODES.reservedForStart:
      // Shared with the card ladder's `reserveHolderName` branch — same situation,
      // same sentence (`planStateLabels.ts`).
      return formatReservedForStartStatus(reason.targetName);
    default:
      return `Limited so ${reason.targetName} can run`;
  }
}

export function formatDeviceReason(reason: DeviceReason): string {
  if (isStaticReason(reason)) return formatStaticReason(reason);
  if (isDetailReason(reason)) return formatDetailReason(reason);
  if (isTimedReason(reason)) return formatTimedReason(reason);
  if (isTargetNameReason(reason)) return formatTargetNameReason(reason);

  switch (reason.code) {
    case PLAN_REASON_CODES.restoreNeed:
      return formatRestoreNeed(reason);
    case PLAN_REASON_CODES.shortfall:
      return formatShortfall(reason);
    case PLAN_REASON_CODES.insufficientHeadroom:
      return formatInsufficientHeadroom(reason);
    case PLAN_REASON_CODES.shedInvariant:
      return `shed invariant: ${reason.fromStep} -> ${reason.toStep} blocked `
        + `(${reason.shedDeviceCount} device(s) shed, max step: ${reason.maxStep})`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

// ─── User-facing reason text ─────────────────────────────────────────────────
//
// `formatDeviceReason` above is the diagnostic/log format. The helpers below
// produce user-facing text per `notes/ui-terminology.md`. They never expose
// internal planner terms (`shed`, `restore`, `headroom`, `shortfall`,
// `backoff`, `invariant`, `soft limit`). `restoreNeed` and `shortfall` reasons
// translate the `(need X kW, headroom Y kW)` template to `needs X kW, Y kW
// available`; `insufficientHeadroom` renders the admission-accurate
// `needs N kW more` instead (see `resolveRestoreShortfallKw`) — for a blocked
// restore, the need/available pair reads as if freeing the difference would
// resume the device, which understates the real gate by the reserve stack.

function normalizeDetailSentence(detail: string): string {
  return detail.length > 0 ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}` : detail;
}

// Finiteness-guarded, not null-guarded: its one caller now holds two required
// `number`s, so absence is gone — but a `NaN`/`Infinity` arriving from a snapshot
// is still worth declining rather than rendering as "needs NaN kW".
function formatNeedAvailableSuffix(needKw: number, availableKw: number): string | null {
  if (!Number.isFinite(needKw) || !Number.isFinite(availableKw)) return null;
  // Clamp negative headroom to 0 kW so users do not see confusing minus signs;
  // negative values mean the system is already over the limit.
  const safeAvailable = Math.max(0, availableKw);
  return `needs ${needKw.toFixed(1)} kW, ${safeAvailable.toFixed(1)} kW available`;
}

const readFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

// The kW a blocked restore is actually short by — the number that, if it became
// available, would admit the device. Admission passes at
// `postReserveMarginKw >= minimumRequiredPostReserveMarginKw`
// (`lib/plan/admission/reserve.ts` + `lib/plan/planReasonsRestoreGating.ts`), and
// `postReserveMarginKw` already folds in the inflated need, the admission
// reserve, and any swap reserve (via effective available). So the honest gap is
// `minimumRequired − postReserveMargin` — NOT `need − available`, which
// understates by the reserve stack (~0.5 kW, +0.3 kW on swap paths). Prod
// 2026-08-01: cards read "0.5 kW more needed" for a device admission would only
// pass with ~1.05 kW more. `shortfall` reasons keep `need − headroom`: that is a
// shed-side deficit with no admission reserves in play. Accepts `unknown`
// because temperature-card callers hold the reason untyped after the snapshot
// boundary — so the finiteness guards below stay even though the type now
// promises both margins (a snapshot from another build is untrusted input).
// Ceil to the 0.1 kW display resolution (with an epsilon guard against float
// noise like 0.799999… → 0.8). Rounding DOWN would contradict the resolver's
// contract: a true gap of 1.04 kW rendered as "1.0" invites freeing exactly
// 1.0 kW and still being 0.04 kW short. Ceiling also kills the
// "0.0 kW more needed" wart for gaps in (0.01, 0.05) — they now render 0.1.
export const ceilToDisplayKw = (gap: number): number | null => (
  gap > 0.01 ? Math.ceil(gap * 10 - 1e-9) / 10 : null
);

export function resolveRestoreShortfallKw(reason: unknown): number | null {
  if (typeof reason !== 'object' || reason === null) return null;
  const r = reason as Record<string, unknown>;
  // A hold that carries a producer-resolved shortfall wins: the producer had the
  // admission metrics this reason code no longer carries (a `dailyBudget`
  // re-attribution, a swap victim, a startup reservation). Already rounded, so
  // it is returned as-is rather than re-ceilinged.
  const carried = readFiniteNumber(r['shortfallKw']);
  if (carried !== null) return carried > 0 ? carried : null;
  if (r['code'] === PLAN_REASON_CODES.insufficientHeadroom) {
    const postReserveMarginKw = readFiniteNumber(r['postReserveMarginKw']);
    const minimumRequiredKw = readFiniteNumber(r['minimumRequiredPostReserveMarginKw']);
    // Both are required `number` on the reason type. A snapshot that still
    // lacks them is malformed, not "legacy": derive nothing and let the card
    // fall to its bare waiting line rather than fabricating a gap from `needKw`
    // against an availability figure the producer never resolved.
    if (postReserveMarginKw === null || minimumRequiredKw === null) return null;
    return ceilToDisplayKw(minimumRequiredKw - postReserveMarginKw);
  }
  if (r['code'] === PLAN_REASON_CODES.shortfall) {
    // Both are required `number` on the reason type; a snapshot missing either is
    // malformed, so derive nothing rather than treating an absent figure as 0 —
    // that fabricated a full-need gap out of half a reason.
    const needKw = readFiniteNumber(r['needKw']);
    const headroomKw = readFiniteNumber(r['headroomKw']);
    if (needKw === null || headroomKw === null) return null;
    return ceilToDisplayKw(needKw - headroomKw);
  }
  return null;
}

export function formatShortfallReason(opts: {
  needKw: number;
  headroomKw: number;
}): string {
  const base = 'Manual action needed. Hard cap may be exceeded.';
  const suffix = formatNeedAvailableSuffix(opts.needKw, opts.headroomKw);
  return suffix ? `Manual action needed. ${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}.` : base;
}

// Reads the loosely-typed `detail` slot off a `DeviceReason`-shaped value
// without an `as` cast. The snapshot boundary serialises some reason variants
// with a `detail` field (`keep`, `hourlyBudget`, `dailyBudget`,
// `sheddingActive`, `inactive`, `capacity`) and others without one; callers
// often hold the value as `unknown` after crossing the IPC boundary. This
// helper accepts `unknown`, returns `unknown`, and centralises the narrowing
// so the published contract between settings-ui and the shared-domain
// reason helpers stays typed at the boundary.
export type DeviceReasonWithDetail = { readonly detail?: unknown };
export function readDeviceReasonDetail(reason: unknown): unknown {
  if (typeof reason !== 'object' || reason === null || !('detail' in reason)) return undefined;
  return (reason as DeviceReasonWithDetail).detail;
}

// "Still drawing … kW — this still counts toward your usage" sentence used by
// the Overview device card when a held device is still drawing power — e.g. an
// EV charger that ignored the pause. Lives in shared-domain so logs and UI produce the same
// wording (`feedback_ui_text_shared_with_logs`). The `detail` slot accepts
// `unknown` because the upstream `DeviceReason.detail` field is loosely typed
// at the snapshot boundary; non-string values are dropped silently rather
// than rendered as `[object Object]`.
export function resolveReportedLoadAfterPauseText(params: {
  currentDrawKw: number | undefined;
  detail: unknown;
  // Simulation mode: PELS never actually paused the device, so the real-mode
  // "after pause" framing would assert an action that did not happen — the
  // exact self-contradiction the simulation-honesty work exists to kill. State
  // the (real) live draw hypothetically instead, with no phantom pause.
  dryRun?: boolean;
}): string {
  const measured = typeof params.currentDrawKw === 'number' && Number.isFinite(params.currentDrawKw)
    ? params.currentDrawKw.toFixed(1)
    : '–';
  const detail = typeof params.detail === 'string' && params.detail.trim().length > 0
    ? params.detail.trim()
    : null;
  const stem = params.dryRun
    ? `Would still draw ${measured} kW`
    : `Still drawing ${measured} kW`;
  // Name the user consequence, not the planner internal: a device that ignores
  // the pause still counts against the household's usage this hour. Canonical
  // "counts toward your usage" vocabulary (notes/ui-terminology.md). A concrete
  // runtime-supplied detail (rare) overrides the generic consequence line. The
  // hypothetical variant carries the trailing `(simulation)` tag — with the
  // 2026-07 card grammar the reason line is the card's only hypothetical
  // carrier, so the tag keeps a scrolled card honest on its own.
  return `${stem} — ${detail ?? 'this still counts toward your usage'}${params.dryRun ? ' (simulation)' : ''}`;
}

// Reported-load conflict line for a "Run on solar surplus" dump load the user
// just switched on by hand while it is surplus-held: the generic
// `resolveReportedLoadAfterPauseText` ("after pause") is wrong here — a
// baseline-off dump load was never paused, and that copy would displace the
// surplus explanation exactly when the user needs it. This names what PELS is
// doing (switching it off to wait for export) so the reconcile contract reads
// coherently on the card. Shared-domain so logs and UI match.
export function resolveSurplusHoldReportedLoadText(params: {
  currentDrawKw: number | undefined;
  // Simulation mode: PELS never actually switches the dump load off, so the
  // real-mode "switching off" framing would assert an action that did not
  // happen. State it hypothetically instead (simulation-honesty rule).
  dryRun?: boolean;
}): string {
  const measured = typeof params.currentDrawKw === 'number' && Number.isFinite(params.currentDrawKw)
    ? params.currentDrawKw.toFixed(1)
    : '–';
  const action = params.dryRun ? 'would switch off' : 'switching off';
  // Trailing `(simulation)` tag on the hypothetical variant — same rule as
  // `resolveReportedLoadAfterPauseText` above.
  return `Still reporting ${measured} kW — ${action} to wait for solar surplus${params.dryRun ? ' (simulation)' : ''}`;
}

function formatRestoreNeedUserFacing(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.restoreNeed }>,
): string {
  // A resume at the lowest step arrives with fromTarget === toTarget; "Raising
  // target low to low" is a broken sentence, so state the resume instead.
  if (reason.fromTarget === reason.toTarget) {
    return `Turning back on at ${formatStepDisplayLabel(reason.toTarget)}`;
  }
  return `Raising target ${formatStepDisplayLabel(reason.fromTarget)} to ${formatStepDisplayLabel(reason.toTarget)}`;
}

function formatInsufficientHeadroomUserFacing(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.insufficientHeadroom }>,
): string {
  // The suffix names the admission-accurate shortfall ("1.1 kW more needed") —
  // same grammar as the card lines — not the raw need/available pair, which
  // reads as if freeing `need − available` would resume the device and
  // understates the real gate by the reserve stack (see
  // `resolveRestoreShortfallKw`).
  const shortfallKw = resolveRestoreShortfallKw(reason);
  const suffix = shortfallKw !== null ? `${shortfallKw.toFixed(1)} kW more needed` : null;
  return suffix ? `Not enough available power to resume — ${suffix}` : 'Not enough available power to resume';
}

const TIMED_REASON_LABELS = {
  [PLAN_REASON_CODES.cooldownShedding]: 'Waiting after limiting a device',
  [PLAN_REASON_CODES.meterSettling]: 'Waiting for power meter to stabilise',
  [PLAN_REASON_CODES.activationBackoff]: 'Delaying restart after recent failed attempt',
  [PLAN_REASON_CODES.restorePending]: 'Resume pending',
} as const;

function formatStaticReasonUserFacing(reason: StaticReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.restoreThrottled:
      return 'Delaying restart to avoid rapid cycling';
    case PLAN_REASON_CODES.waitingForOtherDevices:
      return 'Waiting to resume — other devices are ahead';
    case PLAN_REASON_CODES.externalOffHold:
      return PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS;
    case PLAN_REASON_CODES.neutralStartupHold:
      return 'Left off after startup';
    case PLAN_REASON_CODES.startupStabilization:
      return 'Waiting after startup';
    case PLAN_REASON_CODES.capacityControlOff:
      return 'Power-limit control off';
    // Same strings as the card ladder (`resolveHeldCardReasonLine`) so the
    // activity log and the card cannot drift.
    case PLAN_REASON_CODES.hourlyBudget:
      return PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS;
    case PLAN_REASON_CODES.dailyBudget:
      return PLAN_STATE_DAILY_BUDGET_STATUS;
    case PLAN_REASON_CODES.capacity:
      return PLAN_STATE_CAPACITY_STATUS;
    case PLAN_REASON_CODES.deferredObjectiveAvoid:
      return PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS;
    case PLAN_REASON_CODES.awaitingSolarSurplus:
      return PLAN_STATE_AWAITING_SOLAR_SURPLUS_STATUS;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatDetailReasonUserFacing(reason: DetailReason): string {
  switch (reason.code) {
    case PLAN_REASON_CODES.keep:
      return reason.detail ? normalizeDetailSentence(reason.detail) : '';
    case PLAN_REASON_CODES.inactive:
      return `Off for now (${reason.detail})`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function formatTimedReasonUserFacing(reason: TimedReason): string {
  if (reason.code === PLAN_REASON_CODES.cooldownRestore) {
    return `Waiting to resume — ${formatRemainingSec(reason.remainingSec)}s`;
  }
  return `${TIMED_REASON_LABELS[reason.code]} (${formatRemainingSec(reason.remainingSec)}s)`;
}

// The stepped fairness rule: a stepped device may not climb above its lowest
// useful step while other devices are still held back. Until 2026-08-02 this
// read "Blocked by safety rule" — jargon, and wrong twice over: it is a fairness
// rule, not a safety one, and it named no cause the owner could act on.
//
// Two things this line must NOT say, both learned from prod:
//
//  - Not "Blocked": the invariant only refuses step *increases*. It never pushes
//    a device down, so a device running happily at its current step is not
//    blocked (prod 2026-07-25: an EV charger `Active` at 1.36 kW read as
//    blocked).
//  - Not `Limited to {maxStep}`: `maxStep` is the invariant's CAP, not where the
//    device is. Prod 2026-07-05 showed "Limited to Low" while the device ran at
//    Medium drawing 1.2 kW. The device's own step is `fromStep`, so the line
//    renders from that and falls back to the step-less form when the observed
//    step is unknown rather than substituting the cap.
//
// The remedy is also named honestly: those other devices resuming lifts this
// hold, not more available power.
function formatShedInvariantUserFacing(
  reason: Extract<DeviceReason, { code: typeof PLAN_REASON_CODES.shedInvariant }>,
): string {
  const noun = reason.shedDeviceCount === 1 ? 'device is' : 'devices are';
  const tail = `cannot increase while ${reason.shedDeviceCount} ${noun} limited`;
  const currentStep = formatStepDisplayLabel(reason.fromStep);
  return currentStep === '' || reason.fromStep === 'unknown'
    ? `Holding — ${tail}`
    : `Holding at ${currentStep} — ${tail}`;
}

export function formatDeviceReasonUserFacing(reason: DeviceReason): string {
  if (isStaticReason(reason)) return formatStaticReasonUserFacing(reason);
  if (isDetailReason(reason)) return formatDetailReasonUserFacing(reason);
  if (isTimedReason(reason)) return formatTimedReasonUserFacing(reason);
  if (isTargetNameReason(reason)) return formatTargetNameReasonUserFacing(reason);

  switch (reason.code) {
    case PLAN_REASON_CODES.restoreNeed:
      return formatRestoreNeedUserFacing(reason);
    case PLAN_REASON_CODES.shortfall:
      return formatShortfallReason({ needKw: reason.needKw, headroomKw: reason.headroomKw });
    case PLAN_REASON_CODES.insufficientHeadroom:
      return formatInsufficientHeadroomUserFacing(reason);
    case PLAN_REASON_CODES.shedInvariant:
      return formatShedInvariantUserFacing(reason);
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
