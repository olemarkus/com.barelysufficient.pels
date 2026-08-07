import {
  PLAN_REASON_CODES,
  type DeviceReason,
  type PlanReasonCode,
} from './planReasonSemanticsCore';

type ComparablePlanReasonBase = {
  code: PlanReasonCode;
};

type ComparableTextReason = ComparablePlanReasonBase & {
  text: string;
};

export type ComparablePlanReason =
  | ComparablePlanReasonBase
  | (ComparablePlanReasonBase & { detail: string | null; reserveHolderName?: string | null })
  | (ComparablePlanReasonBase & { targetName: string | null; reserveHolderName?: string | null })
  | (ComparablePlanReasonBase & {
    kind: 'recent_pels_shed' | 'recent_pels_restore' | 'usage_step_down';
  })
  | (ComparablePlanReasonBase & {
    fromTarget: string | null;
    toTarget: string | null;
    needW: number;
    headroomW: number | null;
  })
  | (ComparablePlanReasonBase & {
    needW: number;
    availableW: number | null;
    postReserveMarginW: number | null;
    minimumRequiredPostReserveMarginW: number | null;
    penaltyExtraW: number | null;
    swapReserveW: number | null;
    effectiveAvailableW: number | null;
    swapTargetName: string | null;
  })
  | (ComparablePlanReasonBase & {
    fromStep: string;
    toStep: string;
    shedDeviceCount: number;
    maxStep: string;
  })
  | ComparableTextReason;

// `dailyBudget` and `capacity` stay here — compared on `detail` alone — even
// though they carry a `shortfallKw` the card renders (as do the swap variants
// below, compared on `targetName` alone). That kW is DELIBERATELY excluded
// from every comparable: since `finalizeCeilingReason` attaches it to every
// ceiling hold each cycle, it moves with `softLimitKw − totalKw`, both of which
// drift continuously, so folding it in would flip this signature on most plan
// cycles. That signature gates the per-device device-log ring buffer
// (`planOverviewEmit.ts` → a 50-entry recorder), and the logged `statusMsg` for
// a budget hold does not contain the kW — so the ring would fill with textually
// identical rows and evict the real transitions it exists to keep.
//
// Same rule, same reason as `shortfall` sitting in `CODE_ONLY_REASONS` below;
// pinned by "ignores shortfall jitter in overview transition signatures" in
// `test/unit/deviceOverview.test.ts`. The card still shows a current number
// because `normalizePlanMeta` rounds `totalKw`/`softLimitKw` to 0.1 kW and any
// change there already pushes the whole plan to the UI.
//
// `reserveHolderName` — the OTHER display-only annotation `finalizeCeilingReason`
// attaches — is folded in, and the difference is the churn, not the fact that
// both are display-only. The exclusion above is earned by a number that moves
// with `softLimitKw − totalKw` every cycle; a holder's NAME changes only when the
// reserving device changes or its reservation lifts, which is a real transition
// worth one ring-buffer row and worth a `plan_updated`. Leaving it out meant a
// card could keep "Waiting so X can start" — or fail to start showing it — until
// something unrelated moved the signature. Do not "restore consistency" by
// dropping it to match `shortfallKw`; they are excluded/included on frequency.
type DetailComparableReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.keep }
  | { code: typeof PLAN_REASON_CODES.inactive }
  | { code: typeof PLAN_REASON_CODES.hourlyBudget }
  | { code: typeof PLAN_REASON_CODES.dailyBudget }
  | { code: typeof PLAN_REASON_CODES.capacity }
  | { code: typeof PLAN_REASON_CODES.deferredObjectiveAvoid }
  | { code: typeof PLAN_REASON_CODES.awaitingSolarSurplus }
>;

const CODE_ONLY_REASONS = new Set<PlanReasonCode>([
  PLAN_REASON_CODES.none,
  PLAN_REASON_CODES.shortfall,
  PLAN_REASON_CODES.restoreThrottled,
  PLAN_REASON_CODES.waitingForOtherDevices,
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.activationBackoff,
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.externalOffHold,
  PLAN_REASON_CODES.neutralStartupHold,
  PLAN_REASON_CODES.startupStabilization,
  PLAN_REASON_CODES.capacityControlOff,
]);

type CodeOnlyReason = Extract<
  DeviceReason,
  | { code: typeof PLAN_REASON_CODES.none }
  | { code: typeof PLAN_REASON_CODES.shortfall }
  | { code: typeof PLAN_REASON_CODES.restoreThrottled }
  | { code: typeof PLAN_REASON_CODES.waitingForOtherDevices }
  | { code: typeof PLAN_REASON_CODES.cooldownShedding }
  | { code: typeof PLAN_REASON_CODES.cooldownRestore }
  | { code: typeof PLAN_REASON_CODES.meterSettling }
  | { code: typeof PLAN_REASON_CODES.activationBackoff }
  | { code: typeof PLAN_REASON_CODES.restorePending }
  | { code: typeof PLAN_REASON_CODES.externalOffHold }
  | { code: typeof PLAN_REASON_CODES.neutralStartupHold }
  | { code: typeof PLAN_REASON_CODES.startupStabilization }
  | { code: typeof PLAN_REASON_CODES.capacityControlOff }
>;

function isCodeOnlyReason(reason: DeviceReason): reason is CodeOnlyReason {
  return CODE_ONLY_REASONS.has(reason.code);
}

/**
 * Quantize a kW value to the nearest 100 W and return integer watts. Comparable
 * reasons feed JSON.stringify-based signatures (overview transitions, restore
 * debug dedupe). Raw kW float jitter below 100 W can churn the signature even
 * when the admission decision did not materially change. Integer watts are an
 * exact dedupe key and remove float-equality fuzziness entirely; the 100 W
 * bucket preserves device-specific coarse magnitude. See `notes/units.md` for
 * the general "prefer W internally, kW only at the UI" principle.
 */
function quantizeKwToW(value: number): number;
function quantizeKwToW(value: number | null): number | null;
function quantizeKwToW(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 10) * 100;
}

function isDetailComparableReason(reason: DeviceReason): reason is DetailComparableReason {
  return reason.code === PLAN_REASON_CODES.keep
    || reason.code === PLAN_REASON_CODES.inactive
    || reason.code === PLAN_REASON_CODES.hourlyBudget
    || reason.code === PLAN_REASON_CODES.dailyBudget
    || reason.code === PLAN_REASON_CODES.capacity
    || reason.code === PLAN_REASON_CODES.deferredObjectiveAvoid
    || reason.code === PLAN_REASON_CODES.awaitingSolarSurplus;
}

// Folds the holder in only when the reason actually carries it, so a reason
// without a reservation annotation keeps its previous comparable shape byte for
// byte — an always-present `reserveHolderName: undefined` would change every
// existing signature the first time this shipped and flush every ring buffer.
function withReserveHolder<T extends ComparablePlanReason>(comparable: T, reason: DeviceReason): T {
  if (!('reserveHolderName' in reason) || reason.reserveHolderName === undefined) return comparable;
  return { ...comparable, reserveHolderName: reason.reserveHolderName };
}

export function buildComparableDeviceReason(reason: DeviceReason | undefined): ComparablePlanReason {
  if (!reason) return { code: PLAN_REASON_CODES.none };
  if (isCodeOnlyReason(reason)) return { code: reason.code };
  if (isDetailComparableReason(reason)) {
    return withReserveHolder({ code: reason.code, detail: reason.detail }, reason);
  }

  switch (reason.code) {
    case PLAN_REASON_CODES.swapPending:
    case PLAN_REASON_CODES.swappedOut:
    case PLAN_REASON_CODES.reservedForStart:
      return withReserveHolder({ code: reason.code, targetName: reason.targetName }, reason);
    case PLAN_REASON_CODES.headroomCooldown:
      return { code: reason.code, kind: reason.kind };
    case PLAN_REASON_CODES.restoreNeed:
      return {
        code: reason.code,
        fromTarget: reason.fromTarget,
        toTarget: reason.toTarget,
        needW: quantizeKwToW(reason.needKw),
        headroomW: quantizeKwToW(reason.headroomKw),
      };
    case PLAN_REASON_CODES.insufficientHeadroom:
      return {
        code: reason.code,
        needW: quantizeKwToW(reason.needKw),
        availableW: quantizeKwToW(reason.availableKw),
        postReserveMarginW: quantizeKwToW(reason.postReserveMarginKw),
        minimumRequiredPostReserveMarginW: quantizeKwToW(reason.minimumRequiredPostReserveMarginKw),
        penaltyExtraW: quantizeKwToW(reason.penaltyExtraKw),
        swapReserveW: quantizeKwToW(reason.swapReserveKw),
        effectiveAvailableW: quantizeKwToW(reason.effectiveAvailableKw),
        swapTargetName: reason.swapTargetName,
      };
    case PLAN_REASON_CODES.setTarget:
      return { code: reason.code, text: reason.targetText };
    case PLAN_REASON_CODES.shedInvariant:
      return {
        code: reason.code,
        fromStep: reason.fromStep,
        toStep: reason.toStep,
        shedDeviceCount: reason.shedDeviceCount,
        maxStep: reason.maxStep,
      };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
