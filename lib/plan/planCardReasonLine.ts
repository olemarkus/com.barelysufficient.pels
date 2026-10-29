import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemanticsCore';
import {
  formatDeviceReasonUserFacing, formatSteppedFairnessHoldLine, formatSteppedFairnessNeed, resolveRestoreShortfallKw,
} from '../../packages/shared-domain/src/planReasonFormatting';
import { formatStarvationDurationLabel, formatStarvationReason } from '../../packages/shared-domain/src/planStarvation';
import {
  PLAN_STATE_HELD_FALLBACK_STATUS,
  PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS,
  PLAN_STATE_HOUR_ENDING_STATUS,
  formatReservedForStartStatus,
} from '../../packages/shared-domain/src/planStateLabels';
import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemanticsCore';
import type { SettingsUiPlanDeviceStarvation } from '../../packages/contracts/src/settingsUiApi';
import type { ObservedCurrentState, SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { SteppedFairnessHold } from './planTypes';

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
  PLAN_REASON_CODES.gridImport,
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.dailyBudget,
  PLAN_REASON_CODES.insufficientHeadroom,
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
//   deferredObjectiveSatisfied  the user's own smart task is done and holds the device
//                           until its ready-by time
//   awaitingSolarSurplus    opted-in dump load waiting for export
//   externalOffHold         turned off outside PELS; the recourse is a switch
//   shedInvariant           stepped fairness rule; restoring OTHER devices lifts it
//   shortfall               PELS is out of levers. Not a ceiling either: the house-level
//                           recourse ("Manual action needed") belongs to the hero and
//                           the shortfall alarm. It still carries this device's gap
//                           (attached by `finalizeCeilingReason`), which the card
//                           states in its own branch below
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
// This set used to carry a second clause excluding the `other` code, because
// `lib/plan/swap/candidates.ts` built an `other` reason whose text came from the
// LOG formatter ("insufficient headroom (need 1.36kW, …) from Bathroom,
// Hallway") and `formatDeviceReasonUserFacing` would return it verbatim onto a
// card. That reason never actually reached a device — the swap candidate's value
// only ever fed two log payloads — and the code was removed with the round-trip
// (2026-08-07), so the exclusion has nothing left to exclude.
const KNOWN_REASON_CODES: ReadonlySet<string> = new Set(Object.values(PLAN_REASON_CODES));

const readReasonCode = (reason: unknown): string | undefined => {
  if (typeof reason !== 'object' || reason === null) return undefined;
  const code = (reason as { code?: unknown }).code;
  return typeof code === 'string' && KNOWN_REASON_CODES.has(code) ? code : undefined;
};

const readRemainingSeconds = (reason: unknown): number | null => {
  if (typeof reason !== 'object' || reason === null) return null;
  const remainingSec = (reason as { remainingSec?: unknown }).remainingSec;
  return typeof remainingSec === 'number' && Number.isFinite(remainingSec)
    ? Math.round(Math.max(0, remainingSec))
    : null;
};

// The display-only holder name a ceiling hold carries when admission declined
// solely on a startup reservation (`ReserveHolder`, `planReasonSemanticsCore.ts`).
// `undefined` means "no reservation is the blocker" and the ladder falls through
// to the gap.
//
// Two states, not three. A reservation whose holder could not be NAMED used to
// be a third — it is not a state any producer can build: the annotation is
// attached only on the `blocked_by_reserve` branch, which needs a live claiming
// reserve, and every reserve carries a required `deviceName`.
//
// The guard itself stays, and is not the same thing as that state: this is the
// settings-UI snapshot boundary, and the reason arrives here as `unknown`, so
// classifying untrusted input is this function's job (root `AGENTS.md`,
// "Validation belongs at the boundary"). What changed is where junk lands —
// anything that is not a non-empty string is now "no reservation is the
// blocker", the same honest fallthrough a missing key gets, instead of being
// promoted to a semantic state the runtime type no longer admits.
const readReserveHolderName = (reason: unknown): string | undefined => {
  if (typeof reason !== 'object' || reason === null) return undefined;
  if (!('reserveHolderName' in reason)) return undefined;
  const name = (reason as { reserveHolderName?: unknown }).reserveHolderName;
  return typeof name === 'string' && name !== '' ? name : undefined;
};

// `increase` is the stepped card's variant: the device is running but was denied
// a step up, so "resume" would misdescribe it. Only the verb differs — the
// number and the ladder are identical.
export type HeldCardReasonVerb = 'resume' | 'increase';

/**
 * The step facts the held-card verb needs, resolved by the caller.
 *
 * `steppedLoadProfile` is the ladder or `null` — its PRESENCE is stepped-ness,
 * the same discriminant `isSteppedLoadDevice` / `isSteppedLoadSnapshot` narrow
 * on. There is deliberately no separate `stepped` flag: a flag is a second
 * encoding of what the profile already says, and two encodings can disagree.
 * The verb used to infer it from `controlModel === 'stepped_load'` — a
 * producer-only setting two of its callers never carried — and to treat a step
 * id with no ladder as stepped, which is incoherent: a device cannot be on a
 * rung of a ladder it does not have.
 */
export type HeldCardStepView = {
  steppedLoadProfile: SteppedLoadProfile | null;
};

/**
 * Resolve the step view from a card carrier. Two shapes reach the cards and
 * they keep the ladder in different places: a plan device carries
 * `steppedLoadProfile` directly (on its stepped variant), while an
 * overview-shaped snapshot carries it on `steppedLoad`, whose `profile` is
 * required — so `steppedLoad` presence is ladder presence there.
 *
 * That two-carrier reconciliation used to live INSIDE the verb, which is why
 * the verb needed a tag to tell it what it was looking at. It happens once
 * here, and every caller hands the verb a single resolved ladder-or-null.
 * Callers already holding a narrowed profile skip this and pass it directly.
 */
export const resolveHeldCardStepView = (device: {
  steppedLoadProfile?: SteppedLoadProfile;
  steppedLoad?: { profile: SteppedLoadProfile; reportedStepId: string | null };
}): HeldCardStepView => ({
  steppedLoadProfile: device.steppedLoadProfile ?? device.steppedLoad?.profile ?? null,
});

export const resolveHeldCardReasonVerb = (device: HeldCardStepView & {
  currentState: ObservedCurrentState;
}): HeldCardReasonVerb => (
  device.steppedLoadProfile !== null && device.currentState === 'on'
    ? 'increase'
    : 'resume'
);

// The need clause every ceiling-hold line ends in, held apart from the stem so
// the starved form below can reuse it verbatim.
const formatShortfallNeed = (shortfallKw: number): string => (
  `${shortfallKw.toFixed(1)} kW more needed`
);

const HOURLY_EXHAUSTED_NEED = "this capacity period's budget is spent";
const HOUR_ENDING_NEED = 'this hour is ending';

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
const formatHeldNeedLine = (
  need: string,
  verb: HeldCardReasonVerb,
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): string => {
  const starvedForMs = resolveStarvedForMs(starvation);
  return starvedForMs === null
    ? `Waiting to ${verb} — ${need}`
    : formatStarvedHoldLine(starvedForMs, need);
};

/**
 * The stepped fairness hold on a card: `Holding at 6 A — cannot increase while 2
 * devices are limited`, or, once the device is held back, the elapsed-hold stem
 * with the same need (`Held 2 h — cannot increase while 2 devices are limited`),
 * so the card still says why it carries the rescue.
 */
export const formatFairnessHoldCardLine = (
  hold: SteppedFairnessHold,
  starvation?: SettingsUiPlanDeviceStarvation | null,
): string => {
  const starvedForMs = resolveStarvedForMs(starvation);
  return starvedForMs === null
    ? formatSteppedFairnessHoldLine(hold.stepId, hold.limitedDeviceCount)
    : formatStarvedHoldLine(starvedForMs, formatSteppedFairnessNeed(hold.limitedDeviceCount));
};

// A running stepped device denied a step-up says only that it is waiting, with no
// figure (owner ruling 2026-10-29). Its gap was the way back to its top step, not
// what the house is over by, so "Waiting to increase — 7.8 kW more needed" read as
// a house shortfall that was not there; the details belong in the preview. A
// held-back device keeps its elapsed stem, and nothing after it.
export const STEP_UP_HELD_LINE = 'Waiting to increase';

export const formatShortfallLine = (
  shortfallKw: number,
  verb: HeldCardReasonVerb,
  starvation?: SettingsUiPlanDeviceStarvation | null,
): string => {
  if (verb === 'increase') {
    const starvedForMs = resolveStarvedForMs(starvation);
    return starvedForMs === null ? STEP_UP_HELD_LINE : `Held ${formatStarvationDurationLabel(starvedForMs)}`;
  }
  return formatHeldNeedLine(formatShortfallNeed(shortfallKw), verb, starvation);
};

// Verb-adjusted form of `PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS` (the
// constant is the `resume` form and stays the log formatter's string).
export const formatHourlyExhaustedLine = (
  verb: HeldCardReasonVerb,
  starvation?: SettingsUiPlanDeviceStarvation | null,
): string => (
  verb === 'resume' && resolveStarvedForMs(starvation) === null
    ? PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS
    : formatHeldNeedLine(HOURLY_EXHAUSTED_NEED, verb, starvation)
);

/**
 * The end-of-hour drain hold (`endOfHourDrain`): the condition, no kW and no
 * promise about the next hour, verb-aware like the spent-period line.
 */
export const formatHourEndingLine = (
  verb: HeldCardReasonVerb,
  starvation?: SettingsUiPlanDeviceStarvation | null,
): string => (
  verb === 'resume' && resolveStarvedForMs(starvation) === null
    ? PLAN_STATE_HOUR_ENDING_STATUS
    : formatHeldNeedLine(HOUR_ENDING_NEED, verb, starvation)
);

// Holds whose honest line is a condition, not a gap, and names no recourse.
// - `hourlyBudget`: the hour's energy budget is spent, and freeing power does
//   not put kWh back into the hour. See `PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS`
//   for why "more budget next hour" was a promise PELS could not keep.
// - `endOfHourDrain`: the device waits for the next hour's target, which the
//   Overview's room against the falling drain pace would contradict as a kW.
// Verb-aware like the shortfall line: a running stepped device denied a step-up
// is not waiting to "resume".
const CONDITION_HOLD_LINES: ReadonlyMap<string, (
  verb: HeldCardReasonVerb,
  starvation?: SettingsUiPlanDeviceStarvation | null,
) => string> = new Map([
  [PLAN_REASON_CODES.hourlyBudget, formatHourlyExhaustedLine],
  [PLAN_REASON_CODES.endOfHourDrain, formatHourEndingLine],
]);

const resolveConditionHoldLine = (
  code: string | undefined,
  verb: HeldCardReasonVerb,
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): string | null => {
  const line = code === undefined ? undefined : CONDITION_HOLD_LINES.get(code);
  return line ? line(verb, starvation) : null;
};

// A named reservation is the MORE SPECIFIC cause, so it is read before the gap —
// same shape as the hourly branch. The two never co-occur: the reserve carve-out
// is exactly the branch where no gap figure is honest, so
// `finalizeCeilingReason` attaches one or the other.
//
// It also beats the starvation fallback. A device held long enough to be
// flagged, whose actual blocker is a named reservation, is better served by
// "Waiting so Water heater can start" than the vaguer "Waiting for available
// power" — and this line takes NO starved decoration: it is a cause line like
// the smart-task and solar holds, not a `<stem> — <need>` line, so "Held 2 h —
// waiting so X can start" never forms. Null when no gap is known.
const resolveCeilingHoldLine = (
  reason: unknown,
  verb: HeldCardReasonVerb,
  starvation: SettingsUiPlanDeviceStarvation | null | undefined,
): string | null => {
  const reserveHolderName = readReserveHolderName(reason);
  if (reserveHolderName !== undefined) return formatReservedForStartStatus(reserveHolderName);
  const shortfallKw = resolveRestoreShortfallKw(reason);
  return shortfallKw === null ? null : formatShortfallLine(shortfallKw, verb, starvation);
};

export const resolveHeldCardReasonLine = (
  reason: unknown,
  starvation?: SettingsUiPlanDeviceStarvation | null,
  verb: HeldCardReasonVerb = 'resume',
): string => {

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

  if (code === PLAN_REASON_CODES.cooldownRestore) {
    const remainingSec = readRemainingSeconds(reason);
    return remainingSec === null
      ? `Waiting to ${verb}`
      : `Waiting to ${verb} — ${remainingSec}s`;
  }
  if (code === PLAN_REASON_CODES.waitingForOtherDevices) {
    return `Waiting to ${verb} — other devices are ahead`;
  }

  // The two ceiling holds that must NOT show a kW name their condition instead
  // (`CONDITION_HOLD_LINES`).
  const conditionLine = resolveConditionHoldLine(code, verb, starvation);
  if (conditionLine !== null) return conditionLine;

  // A device held while PELS is out of levers still needs a known amount to
  // resume, which is the card's line (notes/ui-terminology.md, "Held on power"),
  // the same as every power-liftable hold.
  if (isCeilingHoldReasonCode(code) || code === PLAN_REASON_CODES.shortfall) {
    return resolveCeilingHoldLine(reason, verb, starvation) ?? fallback;
  }

  // Everything else keeps the canonical user-facing sentence the runtime already
  // computes — the same helper that produces the device-detail line and the log
  // string, so the two surfaces cannot drift (feedback_ui_text_shared_with_logs).
  const text = code === undefined ? '' : formatDeviceReasonUserFacing(reason as DeviceReason);
  return typeof text === 'string' && text !== '' ? text : fallback;
};
