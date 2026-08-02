import { PLAN_REASON_CODES } from './planReasonSemanticsCore';
import { formatDeviceReasonUserFacing, resolveRestoreShortfallKw } from './planReasonFormatting';
import { formatStarvationReason } from './planStarvation';
import {
  PLAN_STATE_HELD_FALLBACK_STATUS,
  PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS,
} from './planStateLabels';
import type { DeviceReason } from './planReasonSemanticsCore';
import type { SettingsUiPlanDeviceStarvation } from '../../contracts/src/settingsUiApi';

// The ONE reason line a held device card may show — shared by all three card
// variants (temperature, stepped, generic), which until 2026-08-02 each
// re-derived their own partial version and disagreed with each other and with
// the runtime's own status text.
//
// The governing rule (2026-08-02): **a device card says what THIS device needs;
// the hero says what is limiting the house.** Which ceiling is binding — the
// hard cap, this hour's pace, today's budget — is one house-level fact. Printing
// it on every held card states the same sentence N times while the reader's
// actual question ("what would it take to run this?") goes unanswered. The hero
// names the binding ceiling once, on the safe-pace subline and in its decision
// sentence; the card spends its single exception slot on the kW that would admit
// the device.
//
// The line also must not restate what the card already shows. The bold state
// word is `Limited` and the power fact is beside it, so "Turned off by PELS"
// (the pre-2026-08-02 fallback) contributed nothing — it named the action the
// state word had already named, and dropped the cause the runtime had already
// resolved.
const CEILING_HOLD_REASON_CODES: ReadonlySet<string> = new Set([
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.dailyBudget,
  PLAN_REASON_CODES.insufficientHeadroom,
  // Dead producer (prose parser + tests only) — no arithmetic exists for it, so
  // it always lands on the fallback below. Kept for snapshot compatibility.
  PLAN_REASON_CODES.sheddingActive,
  // Swap holds: another device took the power. The swap PRODUCERS still carry
  // no shortfall (their admission numbers belong to the device being swapped
  // IN), but reason normalization (`finalizeCeilingReason`,
  // `lib/plan/planReasons.ts`) attaches THIS device's own pace-relative gap, so
  // these render the same kW line as every other power-liftable hold.
  PLAN_REASON_CODES.swapPending,
  PLAN_REASON_CODES.swappedOut,
]);

// Codes deliberately NOT in the set above, i.e. holds that keep their own copy,
// because power is not what is holding the device back and a kW figure would be
// a lie — freeing power would not start it:
//   deferredObjectiveAvoid  the user's own smart task is waiting for cheaper hours
//   awaitingSolarSurplus    opted-in dump load waiting for export
//   externalOffHold         turned off outside PELS; the recourse is a switch
//   shedInvariant           stepped fairness rule; restoring OTHER devices lifts it
//   shortfall               PELS is out of levers — a recourse warning, not a ceiling
//   reservedForStart        the power IS there, promised to a named device about to
//                           start; a gap through the reservation would be dominated
//                           by that device's block, so the card names the holder
//   restoreThrottled / waitingForOtherDevices / neutralStartupHold /
//   startupStabilization / the countdown reasons — timing facts with real copy
export const isCeilingHoldReasonCode = (code: string | undefined): boolean => (
  code !== undefined && CEILING_HOLD_REASON_CODES.has(code)
);

// Snapshot-boundary guard. `formatDeviceReasonUserFacing` switches exhaustively
// over `DeviceReason` and its `default` branch is a compile-time `never` check —
// which at RUNTIME returns the reason object itself. A snapshot carrying a code
// this build does not know (an older/newer runtime, a hand-built fixture) would
// therefore put an object where a string belongs, and the card renders blank.
// Only known codes reach the formatter; anything else takes the fallback.
const KNOWN_REASON_CODES: ReadonlySet<string> = new Set(Object.values(PLAN_REASON_CODES));

// `other` is a DIAGNOSTIC carrier, not user-facing copy: `lib/plan/swap/candidates.ts`
// builds its text from `formatDeviceReason` — the log formatter — so it reads
// "restore blocked: insufficient headroom (need 1.36kW, …) from Bathroom, Hallway".
// `formatDeviceReasonUserFacing` returns that verbatim, which would put planner
// jargon straight on a card. Treated as unknown so it takes the fallback.
const isCardRenderableCode = (code: string): boolean => (
  KNOWN_REASON_CODES.has(code) && code !== PLAN_REASON_CODES.other
);

const readReasonCode = (reason: unknown): string | undefined => {
  if (typeof reason !== 'object' || reason === null) return undefined;
  const code = (reason as { code?: unknown }).code;
  return typeof code === 'string' && isCardRenderableCode(code) ? code : undefined;
};

// `increase` is the stepped card's variant: the device is running but was denied
// a step up, so "resume" would misdescribe it. Only the verb differs — the
// number and the ladder are identical.
export type HeldCardReasonVerb = 'resume' | 'increase';

export const formatShortfallLine = (shortfallKw: number, verb: HeldCardReasonVerb): string => (
  `Waiting to ${verb} — ${shortfallKw.toFixed(1)} kW more needed`
);

// Verb-adjusted form of `PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS` (the
// constant is the `resume` form and stays the log formatter's string).
export const formatHourlyExhaustedLine = (verb: HeldCardReasonVerb): string => (
  verb === 'resume'
    ? PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS
    : 'Waiting to increase — more budget next hour'
);

export const resolveHeldCardReasonLine = (params: {
  reason: unknown;
  starvation?: SettingsUiPlanDeviceStarvation | null;
  verb?: HeldCardReasonVerb;
}): string => {
  const { reason, starvation, verb = 'resume' } = params;

  // A budget-releasable hold is the one case with a user action attached ("Let
  // it run now"), so its producer-resolved copy outranks even the shortfall.
  if (starvation?.isStarved && starvation.cause === 'budget') {
    const budgetLine = formatStarvationReason(starvation);
    if (budgetLine) return budgetLine;
  }

  // Capacity-cause starvation is the LAST resort, not the first: its copy
  // ("Waiting for available power") is true but says less than a kW figure, and
  // the hard cap behind it is not a lever the owner can trade against
  // (feedback_hard_cap_is_physical). Used only where nothing more specific
  // exists, so a long-held card never falls back to a blank line.
  const fallback = (starvation?.isStarved ? formatStarvationReason(starvation) : null)
    ?? PLAN_STATE_HELD_FALLBACK_STATUS;

  const code = readReasonCode(reason);

  // The one ceiling hold that must NOT show a kW: the hour's energy budget is
  // spent, and spent kWh cannot be un-spent — no amount of freed power admits
  // the device before the hour rolls over, so the honest line names the
  // recourse (next hour's budget) instead of a gap. Verb-aware like the
  // shortfall line: a running stepped device denied a step-up is not waiting
  // to "resume".
  if (code === PLAN_REASON_CODES.hourlyBudget) {
    return formatHourlyExhaustedLine(verb);
  }

  if (isCeilingHoldReasonCode(code)) {
    const shortfallKw = resolveRestoreShortfallKw(reason);
    return shortfallKw === null ? fallback : formatShortfallLine(shortfallKw, verb);
  }

  // Everything else keeps the canonical user-facing sentence the runtime already
  // computes — the same helper that produces the device-detail line and the log
  // string, so the two surfaces cannot drift (feedback_ui_text_shared_with_logs).
  const text = code === undefined ? '' : formatDeviceReasonUserFacing(reason as DeviceReason);
  return typeof text === 'string' && text !== '' ? text : fallback;
};
