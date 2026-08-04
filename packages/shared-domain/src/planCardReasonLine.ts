import { PLAN_REASON_CODES } from './planReasonSemanticsCore';
import { formatDeviceReasonUserFacing, resolveRestoreShortfallKw } from './planReasonFormatting';
import { formatStarvationDurationLabel, formatStarvationReason } from './planStarvation';
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
// resolved. "Limited to stay within today's budget" (retired 2026-08-04) failed
// the same test twice over: it opened by restating the state word and closed by
// naming a house-level ceiling. A held card that has been held long enough to
// count as starved now says so — `Held 2 h — 0.7 kW more needed` — because the
// duration is the device's own fact, and the only one that explains why THIS
// card carries the "Let it run now" action and its neighbours do not.
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

// The need clause every ceiling-hold line ends in, held apart from the stem so
// the starved form below can reuse it verbatim.
const formatShortfallNeed = (shortfallKw: number): string => (
  `${shortfallKw.toFixed(1)} kW more needed`
);

const HOURLY_EXHAUSTED_NEED = "this hour's budget is spent";

// The starved form of a ceiling hold: "Held 2 h — 0.7 kW more needed". Same need
// clause, but the stem states how long PELS has been holding the device below
// target instead of the generic "Waiting to resume".
//
// The duration is the ONE device-scoped fact that distinguishes this card from
// every other device held in the same cycle — it is why this card, and not its
// neighbours, carries the "Let it run now" action. It replaces the pre-2026-08-04
// line ("Limited to stay within today's budget"), which restated the `Limited`
// state word and then named a house-level ceiling the hero already states once.
//
// `verb` drops out here: "Held 2 h" describes the hold itself, so the
// resume/increase distinction the non-starved stems need does not arise.
const formatStarvedHoldLine = (accumulatedMs: number, need: string): string => (
  `Held ${formatStarvationDurationLabel(accumulatedMs)} — ${need}`
);

// The starved duration to decorate with, or null when the device is not starved.
// A non-positive accumulation takes the plain stem rather than rendering
// `Held 0 min`: an episode latched but not yet accumulated has nothing to report,
// and "held for no time" reads as a bug to the owner.
const resolveStarvedForMs = (
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): number | null => (
  starvation?.isStarved === true
    && Number.isFinite(starvation.accumulatedMs)
    && starvation.accumulatedMs > 0
    ? starvation.accumulatedMs
    : null
);

// The one builder for "<stem> — <need>" lines. A device held long enough to
// count as starved gets the elapsed-hold stem; everything else gets the plain
// waiting stem. Single home so the generic, temperature, and stepped cards
// cannot drift — the stepped card carried its own competing starvation override
// until 2026-08-04, and the two disagreed about which fact won.
const formatHeldNeedLine = (params: {
  need: string;
  verb: HeldCardReasonVerb;
  starvation?: SettingsUiPlanDeviceStarvation | null;
}): string => {
  const { need, verb, starvation } = params;
  const starvedForMs = resolveStarvedForMs(starvation);
  return starvedForMs === null
    ? `Waiting to ${verb} — ${need}`
    : formatStarvedHoldLine(starvedForMs, need);
};

export const formatShortfallLine = (
  shortfallKw: number,
  verb: HeldCardReasonVerb,
  starvation?: SettingsUiPlanDeviceStarvation | null,
): string => formatHeldNeedLine({ need: formatShortfallNeed(shortfallKw), verb, starvation });

// Verb-adjusted form of `PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS` (the
// constant is the `resume` form and stays the log formatter's string).
export const formatHourlyExhaustedLine = (
  verb: HeldCardReasonVerb,
  starvation?: SettingsUiPlanDeviceStarvation | null,
): string => (
  verb === 'resume' && resolveStarvedForMs(starvation) === null
    ? PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS
    : formatHeldNeedLine({ need: HOURLY_EXHAUSTED_NEED, verb, starvation })
);


export const resolveHeldCardReasonLine = (params: {
  reason: unknown;
  starvation?: SettingsUiPlanDeviceStarvation | null;
  verb?: HeldCardReasonVerb;
}): string => {
  const { reason, starvation, verb = 'resume' } = params;

  // Starvation DECORATES a ceiling hold; it never preempts the ladder. Until
  // 2026-08-04 a budget-caused starvation returned its own line from the top of
  // this function, which also swallowed the countdown copy of a device merely
  // waiting out a restore cooldown and the smart-task/solar/external-off causes
  // of a device power could not admit at all. Those keep their own copy below —
  // exactly as this module's header always said they should.

  // Starvation with nothing more specific to say is the LAST resort: its copy
  // ("Waiting for available power") is true but says less than a kW figure.
  // Used only where nothing more specific exists, so a long-held card never
  // falls back to a blank line.
  const fallback = (starvation?.isStarved ? formatStarvationReason(starvation) : null)
    ?? PLAN_STATE_HELD_FALLBACK_STATUS;

  const code = readReasonCode(reason);

  // The one ceiling hold that must NOT show a kW: the hour's energy budget is
  // spent, and freeing power does not put kWh back into the hour, so the honest
  // line names the condition instead of a gap. It names no recourse either —
  // see `PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS` for why "more budget next
  // hour" was a promise PELS could not keep. Verb-aware like the shortfall line:
  // a running stepped device denied a step-up is not waiting to "resume".
  if (code === PLAN_REASON_CODES.hourlyBudget) {
    return formatHourlyExhaustedLine(verb, starvation);
  }

  if (isCeilingHoldReasonCode(code)) {
    const shortfallKw = resolveRestoreShortfallKw(reason);
    return shortfallKw === null ? fallback : formatShortfallLine(shortfallKw, verb, starvation);
  }

  // Everything else keeps the canonical user-facing sentence the runtime already
  // computes — the same helper that produces the device-detail line and the log
  // string, so the two surfaces cannot drift (feedback_ui_text_shared_with_logs).
  const text = code === undefined ? '' : formatDeviceReasonUserFacing(reason as DeviceReason);
  return typeof text === 'string' && text !== '' ? text : fallback;
};
