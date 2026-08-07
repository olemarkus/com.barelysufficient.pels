/**
 * Prose → `DeviceReason` for TEST FIXTURES ONLY.
 *
 * Until 2026-08-07 this lived in `packages/shared-domain/src/planReasonParsing.ts`
 * and shipped in the production bundle, even though its only entry point was
 * reachable exclusively from test helpers. That placement had a real cost: it
 * reconstructed reason objects by regex, so a string missing a section produced
 * a HALF-POPULATED reason — which forced `insufficient_headroom`'s four
 * admission fields to be nullable in the PRODUCTION `DeviceReason` type. Those
 * nulls then justified a `headroom unknown` rendering and a
 * fabricate-the-gap-from-`needKw` fallback in `resolveRestoreShortfallKw`,
 * neither reachable by any live producer: dead branches held open by fixtures.
 *
 * Moving it here is the fix. Fixtures keep their readable prose, production
 * types stay honest, and nothing here can widen them again.
 *
 * `insufficient_headroom` deliberately has NO prose form. Its text does not
 * fully specify the object — a log line may omit the post-reserve margin
 * section — and inventing admission figures to fill the gap is the exact
 * failure this move exists to prevent. Fixtures needing it call
 * `insufficientHeadroomFixtureReason` in `deviceReasonTestUtils.ts`.
 */
import {
  PLAN_REASON_CODES,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemanticsCore';

const KEEP_REASON = /^keep(?: \((.+)\))?$/;
const RESTORE_NEED_REASON = /^restore ([^(]+?) -> ([^(]+?) \(need (-?\d+(?:\.\d+)?)kW\)$/;
const SWAP_PENDING_REASON = /^swap pending(?: \((.+)\))?$/;
const SWAPPED_OUT_REASON = /^swapped out for (.+)$/;
const SHORTFALL_REASON = /^shortfall \(need (-?\d+(?:\.\d+)?)kW, headroom (-?\d+(?:\.\d+)?)kW\)$/;
const COOLDOWN_SHEDDING_REASON = /^cooldown \(shedding, (\d+)s remaining\)$/;
const COOLDOWN_RESTORE_REASON = /^cooldown \(restore, (\d+)s remaining\)$/;
const METER_SETTLING_REASON = /^meter settling \((\d+)s remaining\)$/;
const ACTIVATION_BACKOFF_REASON = /^activation backoff \((\d+)s remaining\)$/;
const RESTORE_PENDING_REASON = /^restore pending \((\d+)s remaining\)$/;
const INACTIVE_REASON = /^inactive \((.+)\)$/;
const SHED_INVARIANT_REASON = (
  /^shed invariant: (.+) -> (.+) blocked \((\d+) device\(s\) shed, max step: (.+)\)$/
);

type ReasonParser = (trimmed: string) => DeviceReason | null;

function normalizeReasonText(reason: string | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseKeepReason(trimmed: string): DeviceReason | null {
  const match = KEEP_REASON.exec(trimmed);
  if (!match) return null;
  return { code: PLAN_REASON_CODES.keep, detail: match[1] ?? null };
}

function parseRestoreNeedReason(trimmed: string): DeviceReason | null {
  const match = RESTORE_NEED_REASON.exec(trimmed);
  if (!match) return null;
  return {
    code: PLAN_REASON_CODES.restoreNeed,
    fromTarget: match[1],
    toTarget: match[2],
    needKw: Number(match[3]),
  };
}

function parseShortfallReason(trimmed: string): DeviceReason | null {
  const match = SHORTFALL_REASON.exec(trimmed);
  if (!match) return null;
  return {
    code: PLAN_REASON_CODES.shortfall,
    needKw: Number(match[1]),
    headroomKw: Number(match[2]),
  };
}

const REGEX_REASON_PARSERS: ReasonParser[] = [
  parseKeepReason,
  parseRestoreNeedReason,
  parseShortfallReason,
  (trimmed) => {
    const match = SWAP_PENDING_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.swapPending, targetName: match[1] ?? null } : null;
  },
  (trimmed) => {
    const match = SWAPPED_OUT_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.swappedOut, targetName: match[1] } : null;
  },
  (trimmed) => {
    const match = COOLDOWN_SHEDDING_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = COOLDOWN_RESTORE_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = METER_SETTLING_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.meterSettling, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = ACTIVATION_BACKOFF_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.activationBackoff, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = RESTORE_PENDING_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.restorePending, remainingSec: Number(match[1]) } : null;
  },
  (trimmed) => {
    const match = INACTIVE_REASON.exec(trimmed);
    return match ? { code: PLAN_REASON_CODES.inactive, detail: match[1] } : null;
  },
  (trimmed) => {
    const match = SHED_INVARIANT_REASON.exec(trimmed);
    if (!match) return null;
    return {
      code: PLAN_REASON_CODES.shedInvariant,
      fromStep: match[1],
      toStep: match[2],
      shedDeviceCount: Number(match[3]),
      maxStep: match[4],
    };
  },
];

const EXACT_REASON_PARSERS: Record<string, DeviceReason> = {
  'restore throttled': { code: PLAN_REASON_CODES.restoreThrottled },
  'waiting for other devices to recover': { code: PLAN_REASON_CODES.waitingForOtherDevices },
  'left off': { code: PLAN_REASON_CODES.neutralStartupHold },
  'startup stabilization': { code: PLAN_REASON_CODES.startupStabilization },
  'capacity control off': { code: PLAN_REASON_CODES.capacityControlOff },
  // The four ceiling/hold codes lost their `detail` slot, so their prose is now
  // exact rather than a prefix with an optional trailing clause.
  'shed due to hourly budget': { code: PLAN_REASON_CODES.hourlyBudget },
  'shed due to daily budget': { code: PLAN_REASON_CODES.dailyBudget },
  'shed due to capacity': { code: PLAN_REASON_CODES.capacity },
  'waiting for cheaper hours': { code: PLAN_REASON_CODES.deferredObjectiveAvoid },
  'waiting for solar surplus': { code: PLAN_REASON_CODES.awaitingSolarSurplus },
  'staying off until turned on again': { code: PLAN_REASON_CODES.externalOffHold },
};

function parseKnownReason(trimmed: string): DeviceReason | null {
  const exactReason = EXACT_REASON_PARSERS[trimmed];
  if (exactReason) return exactReason;

  for (const parser of REGEX_REASON_PARSERS) {
    const parsed = parser(trimmed);
    if (parsed) return parsed;
  }
  return null;
}

// An unrecognised label THROWS. It used to fall to `other` — a carrier holding
// the raw text — and that code left the contract on 2026-08-07 with its only
// runtime producer. Falling to `none` instead would have been worse than either:
// `none` means "this device has no reason", so a stale or misspelled fixture
// would quietly describe a different device than the fixture claims, and the
// test would still pass. `fixtureDeviceReason('capacity')` was already doing
// exactly that — the grammar spells it `shed due to capacity`, so a fixture
// meaning "held on capacity" had been silently producing a reasonless device.
//
// Conflating malformed input with genuine absence is the failure the root
// AGENTS.md boundary rule names outright, and a test helper is not exempt: a
// fixture that lies is a test that proves nothing. Throwing surfaces the typo at
// the call site instead. Every fixture in the repo parses cleanly as of
// 2026-08-07 — if this fires, fix the label (or build the reason object
// directly, as `planDiagnostics.test.ts` does for a deliberately foreign code).
export function buildFixturePlanReason(reason: string | undefined): DeviceReason {
  const trimmed = normalizeReasonText(reason);
  // An absent label means "nothing is holding this device" — which on a live
  // plan is `keep`, not the retired `none` marker.
  if (!trimmed) return { code: PLAN_REASON_CODES.keep, detail: null };
  const parsed = parseKnownReason(trimmed);
  if (!parsed) {
    throw new Error(
      `Unknown plan-reason fixture label: "${trimmed}". Use a label this grammar `
      + 'parses, or build the DeviceReason object directly.',
    );
  }
  return parsed;
}
