import { formatRelativeTime } from './planFormatUtils.ts';

export type PlanHeroMetaInput = {
  totalKw?: number;
  softLimitKw?: number;
  headroomKw?: number;
  hardCapLimitKw?: number | null;
  controlledKw?: number;
  uncontrolledKw?: number;
  lastPowerUpdateMs?: number;
};

export type PowerFreshnessState = 'fresh' | 'stale_hold' | 'stale_fail_closed';

export type HeroTone = 'ok' | 'warn' | 'alert';

// The headline deliberately carries NO instantaneous-vs-hard-cap judgement.
// The hard cap is an hourly-average (tariff-step) ceiling — instantaneous kW
// above it is not a breach and no runtime control path treats it as one
// (`notes/ui-terminology.md` § "Hard cap is an hourly ceiling"). The alert-tier
// hero state is derived from the projected this-hour energy vs the cap by the
// caller, which owns the projection.
export type HeroHeadline = {
  totalKw: number;
  softLimitKw: number;
  hardLimitKw: number | null;
  controlledKw: number | null;
  uncontrolledKw: number | null;
  headroomKw: number;
  overSoftLimit: boolean;
  ageText: string | null;
};

export type FreshnessChipView = {
  kind: PowerFreshnessState;
  label: string;
  tone: HeroTone;
};

export const formatHeroHeadline = (
  meta: PlanHeroMetaInput | undefined,
  nowMs: number,
): HeroHeadline | null => {
  if (!meta) return null;
  const { totalKw, softLimitKw, headroomKw } = meta;
  if (typeof totalKw !== 'number' || typeof softLimitKw !== 'number' || typeof headroomKw !== 'number') {
    return null;
  }

  const hardLimitKw = typeof meta.hardCapLimitKw === 'number' ? meta.hardCapLimitKw : null;
  const overSoftLimit = headroomKw < 0;
  const ageText = typeof meta.lastPowerUpdateMs === 'number'
    ? formatRelativeTime(meta.lastPowerUpdateMs, nowMs)
    : null;

  return {
    totalKw,
    softLimitKw,
    hardLimitKw,
    controlledKw: typeof meta.controlledKw === 'number' ? meta.controlledKw : null,
    uncontrolledKw: typeof meta.uncontrolledKw === 'number' ? meta.uncontrolledKw : null,
    headroomKw,
    overSoftLimit,
    ageText,
  };
};

export const formatFreshnessChip = (
  state: PowerFreshnessState | undefined,
): FreshnessChipView | null => {
  if (!state) return null;
  if (state === 'fresh') return { kind: state, label: 'Live', tone: 'ok' };
  if (state === 'stale_hold') return { kind: state, label: 'Delayed', tone: 'warn' };
  return { kind: state, label: 'No data', tone: 'alert' };
};

/**
 * Formats the "energy used this hour" headline shown on the Overview hero and
 * emitted by the runtime logger so logs match the on-screen wording verbatim.
 * One decimal precision is applied to both sides to keep the pair consistent.
 */
export const formatEnergyUsedOfBudget = (usedKWh: number, budgetKWh: number): string =>
  `${usedKWh.toFixed(1)} of ${budgetKWh.toFixed(1)} kWh used`;

/**
 * Presentation-only split of {@link formatEnergyUsedOfBudget} for the Overview
 * hero's numeric-first layout: the used value leads as the dominant number and
 * the budget context trails as a quiet qualifier. This is a PURE-PRESENTATION
 * helper — it exists so the UI can stack number + qualifier without mutating
 * the log-shared `formatEnergyUsedOfBudget` string.
 *
 * The parts are derived from the SAME `toFixed(1)` values as
 * `formatEnergyUsedOfBudget`, and joining them with a single space
 * (`"<lead> <qualifier>"`) reproduces that wording VERBATIM — so the headline's
 * `textContent` stays byte-identical to the canonical `formatEnergyUsedOfBudget`
 * helper (pinned by a test). `formatEnergyUsedOfBudget` remains the single-string
 * helper for any log breadcrumb that needs it, so the on-screen and logged
 * wording can never drift (see `feedback_ui_text_shared_with_logs.md`).
 */
export const formatEnergyUsedOfBudgetParts = (
  usedKWh: number,
  budgetKWh: number,
): { lead: string; qualifier: string } => ({
  lead: usedKWh.toFixed(1),
  qualifier: `of ${budgetKWh.toFixed(1)} kWh used`,
});

/**
 * Formats the "projected this hour" subline that sits beneath the energy-used
 * headline on the Overview hero. Two-decimal precision matches the energy-bar
 * projection-marker tooltip so the printed numbers line up. Returns `null`
 * when no projection is available so the caller can omit the row entirely
 * (see `feedback_ui_text_shared_with_logs.md` — the runtime logger uses the
 * same helper so logs and UI never drift).
 *
 * The projected value is floored at zero: in a net-export hour the projection
 * (used + remaining net kW) can go negative, and "projected -1.42 kWh"
 * contradicts its own "used" framing and reads as broken — right where the
 * Solar-now line is celebrating export. Mirrors the plan_budget widget's clamp
 * (`planPriceWidgetCopy.ts`) so the two projected surfaces never diverge.
 */
export const formatProjectedEnergySubline = (projectedKWh: number | null): string | null => {
  if (projectedKWh === null) return null;
  return `projected ${Math.max(0, projectedKWh).toFixed(2)} kWh`;
};

// ─── Hero meter marker labels ────────────────────────────────────────────────
// Source of truth for every "what is this dot on the bar?" label the Overview
// hero exposes — used both as `aria-label` (screen-reader) and as the visible
// legend row below the bar. Wording matches `notes/ui-terminology.md`
// § "Hero bar vocabulary" so the screen-reader text mirrors the visible chip /
// tooltip copy. The runtime logger imports these helpers when it emits
// hero-render diagnostics so the wording never drifts between the UI and the
// logs (see `feedback_ui_text_shared_with_logs.md`).

export type HeroMeterMarkerLabels = {
  // Visible legend label. Power-bar markers include the numeric value
  // ("Safe pace now 5.5 kW") because the legend is the only touch-reachable
  // home for those numbers (tippy tooltips need hover); energy-bar markers
  // stay value-free because their numbers already sit in the headline
  // directly above the bar. See `notes/ui-terminology.md` § "Hero legend".
  short: string;
  // Screen-reader label with the numeric value — e.g. "Safe pace now 12.0 kW".
  aria: string;
};

const formatKw = (kw: number): string => `${kw.toFixed(1)} kW`;
const formatKWh = (kwh: number): string => `${kwh.toFixed(1)} kWh`;

export const formatPowerMeterMarkerLabels = (
  kind: 'target' | 'cap',
  valueKw: number,
): HeroMeterMarkerLabels => {
  if (kind === 'cap') {
    const label = `Hard cap ${formatKw(valueKw)}`;
    return { short: label, aria: label };
  }
  const label = `Safe pace now ${formatKw(valueKw)}`;
  return { short: label, aria: label };
};

export const formatEnergyMeterMarkerLabels = (
  kind: 'target' | 'projected' | 'cap',
  valueKWh: number,
): HeroMeterMarkerLabels => {
  if (kind === 'projected') {
    return {
      short: 'Projected this hour',
      aria: `Projected this hour ${formatKWh(valueKWh)}`,
    };
  }
  // The cap marker carries its value visibly (unlike budget/projected, whose
  // numbers sit in the headline directly above the bar): the cap's hourly kWh
  // is the threshold that turns the projection red, and it is printed nowhere
  // else in kWh.
  if (kind === 'cap') {
    const label = `Hard cap this hour ${formatKWh(valueKWh)}`;
    return { short: label, aria: label };
  }
  return { short: 'Budget this hour', aria: `Budget this hour ${formatKWh(valueKWh)}` };
};

// ─── Above-safe-pace subline ─────────────────────────────────────────────────
// `headroomKw` is the spare room before safe pace (negative when above).
// The subline copy matches `notes/overview-hero-spec.md` § "Power now". There
// is deliberately NO above-hard-cap subline: instantaneous kW above the cap is
// not a breach (the cap is an hourly-average ceiling), so the power subline
// only ever compares against the safe pace PELS actually reacts to.

// Keep the safe-pace numeric reference visible in the above-safe-pace state so
// the user can compare "how much over" against the actual target. Spec:
// `notes/overview-hero-spec.md` § "Power now".
//
// `sourceText` names the binding ceiling (`resolveSafePaceSourceText`), inside
// the existing parenthetical rather than as a third clause — at 320 px a second
// separator pushed the line to three rows. Omitted when the source is unknown.
export const formatAboveSafePaceSubline = (
  headroomKw: number,
  safePaceKw: number,
  sourceText?: string | null,
): string => {
  const overshootKw = Math.max(0, -headroomKw);
  const pace = sourceText ? `${formatKw(safePaceKw)} · ${sourceText}` : formatKw(safePaceKw);
  return `${formatKw(overshootKw)} above safe pace (${pace})`;
};

// On-track sibling of the above. Same rule: the ceiling is named here because it
// is named nowhere else the owner can see.
export const formatSafePaceSubline = (
  safePaceKw: number,
  sourceText?: string | null,
): string => {
  const base = `Safe pace now ${formatKw(safePaceKw)}`;
  return sourceText ? `${base} · ${sourceText}` : base;
};

// Energy-bar scale used by the Overview hero. When projected is at-or-below
// budget the budget marker sits at 100 % so the projected dot's visual position
// matches the printed `projected / budget` ratio; when projected overshoots,
// the scale tracks the projection (with 5 % headroom) so the overshoot is
// visible past the budget marker. Source: TODO #5 fix, 2026-05-17.
export const computeEnergyBarScaleKWh = (
  budgetKWh: number,
  projectedKWh: number | null,
  usedKWh: number,
  // The hour's hard-cap ceiling in kWh. Included in the scale for the same
  // reason the power bar's scale includes the cap in kW ("the cap tick must
  // remain visible"): the energy bar's cap marker only renders while the cap is
  // on-scale, and the cap normally sits ABOVE the budget (budget = cap − safety
  // margin, or a tighter daily allocation). Without this the tick was dropped in
  // exactly the healthy case, so the cap was never shown in the unit it actually
  // governs — an hourly kWh ceiling — and only ever appeared as a kW tick on the
  // instantaneous power bar, where "6.7 kW now vs 5.0 kW cap" reads as a breach
  // it is not (prod 2026-07-25).
  hardCapKWh?: number | null,
): number => {
  const overshoot = Math.max(projectedKWh ?? 0, usedKWh);
  const base = overshoot <= budgetKWh ? budgetKWh : overshoot * 1.05;
  const cap = typeof hardCapKWh === 'number' && Number.isFinite(hardCapKWh) && hardCapKWh > 0
    ? hardCapKWh
    : 0;
  return Math.max(base, cap);
};

// ─── Decision sentence (named-subject declarative voice) ─────────────────────
// Single plain-language conclusion at the bottom of the Overview hero. The
// builder lives in shared-domain so the runtime logger and the settings UI
// emit byte-identical wording (see `feedback_ui_text_shared_with_logs.md`).
// Priority ladder is mirrored in `notes/overview-hero-spec.md` § "Decision
// sentence" — keep both in sync.
//
// Voice: third-person observational. The house is the named subject; PELS is
// never "I". No exclamation marks (Nordic register). No em-dash diagnostic
// shape ("Doing X — because Y"). Reading order is the action first, then the
// constraint that motivates it.

export type DecisionSentenceInput = {
  limitedCount: number;
  resumingCount: number;
  freshness: PowerFreshnessState | undefined;
  dryRun: boolean;
  // Projected this-hour energy exceeds the hard cap's hourly kWh — the
  // trajectory condition users read "Above hard cap" as. Never derived from
  // instantaneous kW vs the cap (that is not a breach; see
  // `notes/ui-terminology.md` § "Hard cap is an hourly ceiling").
  projectedOverHardCap: boolean;
  projectedOverBudget: boolean;
  safePaceKw: number | null;
  // Subset of `limitedCount` whose hold is attributed to a smart task waiting
  // for cheaper hours (reason code `deferredObjectiveAvoid`). When the whole
  // limited set falls into this bucket, the decision sentence frames the
  // hold as the user's price-aware plan instead of a capacity defense.
  deferredObjectiveAvoidCount?: number;
  // Subset of `limitedCount` whose hold is attributed to today's daily budget
  // pacing (reason code `dailyBudget`). When the whole limited set falls into
  // this bucket and no smart-task waiting is in play, frame the hold as
  // budget pacing instead of generic capacity defense.
  dailyBudgetLimitedCount?: number;
  // Count of devices actually drawing power (not parked at 0 W) with Power-limit
  // control turned off (reason code `capacityControlOff`, `controllable ===
  // false`). PELS cannot ease these off, so when one is the source of the breach
  // the decision sentence names the user's recourse instead of promising action.
  capacityControlOffCount?: number;
  // Count of controllable managed devices still running (`stateKind ===
  // 'active'`) that PELS could yet ease off. When this is zero while on pace
  // over the hard cap, the managed shed cascade is exhausted — the only
  // remaining draw is whatever PELS cannot touch.
  sheddableManagedRunningCount?: number;
};

export type DecisionSentenceResult = {
  text: string;
  positive: boolean;
};

const formatDevices = (n: number): string => `${n} ${n === 1 ? 'device' : 'devices'}`;

// Pick the most-specific "actively limiting" decision sentence for rule 4 of
// `buildDecisionSentence`. Extracted so the rule ladder stays under the
// SonarJS / ESLint cognitive-complexity caps.
//
// Precedence (highest first):
//   - All limited devices are smart-task waiting → calm "Waiting for cheaper
//     hours" framing. positive: true.
//   - Some limited devices are smart-task waiting → blended comma-join.
//   - All limited devices are daily-budget pacing → "to stay within today's
//     budget" framing.
//   - Otherwise → existing capacity-defense wording (safe-pace clause when
//     `safePaceKw !== null`).
const resolveLimitingDecisionSentence = (input: DecisionSentenceInput): DecisionSentenceResult => {
  const avoidCount = input.deferredObjectiveAvoidCount ?? 0;
  const dailyCount = input.dailyBudgetLimitedCount ?? 0;
  const devicesText = formatDevices(input.limitedCount);

  if (avoidCount > 0 && avoidCount === input.limitedCount) {
    return { text: `Waiting for cheaper hours before running ${devicesText}.`, positive: true };
  }

  if (avoidCount > 0) {
    return {
      text: `Holding back ${devicesText}, ${avoidCount} waiting for cheaper hours.`,
      positive: false,
    };
  }

  if (dailyCount > 0 && dailyCount === input.limitedCount) {
    return { text: `Holding back ${devicesText} to stay within today’s budget.`, positive: false };
  }

  const safePaceText = input.safePaceKw !== null
    ? ` so the house stays under ${formatKw(input.safePaceKw)}`
    : '';
  return { text: `Holding back ${devicesText}${safePaceText}.`, positive: false };
};

// Resolve the on-pace-over-hard-cap decision sentence (rule 2 of
// `buildDecisionSentence`). The trigger is trajectory (projected this-hour
// energy > the cap's hourly kWh), which mathematically implies draw is above
// safe pace — so shedding is genuinely engaged and "easing devices off" is an
// honest claim. When the managed shed cascade is exhausted (no controllable
// managed device left running to ease off) and the remaining breach is
// attributed to a device with Power-limit control turned off, PELS has
// finished mitigating: claiming it is still "easing devices off" overpromises
// action it cannot take. This is the producer-resolved flag — the honest story
// names the real control and the user's recourse (raising the hard cap is
// never offered as a remedy). Extracted so the rule ladder stays under the
// SonarJS / ESLint cognitive-complexity cap.
const resolveOverHardCapDecisionSentence = (
  input: DecisionSentenceInput,
): DecisionSentenceResult => {
  // Simulation mode: PELS is not acting, so neither "Easing devices off" nor
  // the recourse variant may render — state the trajectory alone (the banner
  // and status chip already name simulation; hypothetical-voice rule in
  // `notes/overview-hero-spec.md` § "Decision sentence").
  if (input.dryRun) {
    return { text: 'On pace to exceed the hard cap this hour.', positive: false };
  }
  const capacityControlOffCount = input.capacityControlOffCount ?? 0;
  const sheddableManagedRunningCount = input.sheddableManagedRunningCount ?? 0;
  // "Easing devices off" only while a controllable managed device is actually
  // still drawing — the trajectory trigger alone does not imply PELS has load
  // left to act on (the hour may have banked the energy already, with every
  // managed device settled off and draw near zero).
  if (sheddableManagedRunningCount > 0) {
    return { text: 'On pace to exceed the hard cap this hour. Easing devices off.', positive: false };
  }
  if (capacityControlOffCount === 0) {
    // Nothing left to ease off and no control-off culprit: state the
    // trajectory without claiming action PELS cannot take.
    return { text: 'On pace to exceed the hard cap this hour.', positive: false };
  }
  const offDevices = capacityControlOffCount === 1
    ? 'a device that has Power-limit control turned off'
    : `${capacityControlOffCount} devices that have Power-limit control turned off`;
  const recourse = capacityControlOffCount === 1
    ? 'Turn its Power-limit control back on so PELS can ease it off.'
    : 'Turn their Power-limit control back on so PELS can ease them off.';
  return {
    text: `Managed devices are already eased off. The remaining draw is from ${offDevices}. ${recourse}`,
    positive: false,
  };
};

export const buildDecisionSentence = (
  input: DecisionSentenceInput,
): DecisionSentenceResult => {
  // 1. No data.
  if (input.freshness === 'stale_fail_closed') {
    return {
      text: 'Power readings have dropped. Devices stay limited until data returns.',
      positive: false,
    };
  }

  // 2. On pace to exceed the hard cap this hour (trajectory, never
  // instantaneous kW vs the cap).
  if (input.projectedOverHardCap) return resolveOverHardCapDecisionSentence(input);

  // 3. Simulation mode would act. The banner + `Simulation mode` status chip
  // already name simulation on the Overview; this conclusion drops the
  // redundant "if simulation mode were off" tail so simulation is stated at
  // most twice. It stays hypothetical (`would`) — never implying PELS acted.
  if (input.dryRun && input.limitedCount > 0) {
    return {
      text: `${formatDevices(input.limitedCount)} would be limited right now.`,
      positive: false,
    };
  }

  // 4. Actively limiting. Pick the most-specific framing that honestly
  // describes why the limited devices are being held.
  if (input.limitedCount > 0) return resolveLimitingDecisionSentence(input);

  // 5. Resuming.
  if (input.resumingCount > 0) {
    return {
      text: `Bringing ${formatDevices(input.resumingCount)} back online. Power has stayed under the safe pace.`,
      positive: true,
    };
  }

  // 6. Projected over budget.
  if (input.projectedOverBudget) {
    return {
      text: 'On pace to overshoot this hour’s energy budget.',
      positive: false,
    };
  }

  // 7. On track.
  return { text: 'Quiet hour. Nothing to do.', positive: true };
};

// ─── Anticipation subline (next cheap window) ────────────────────────────────
// Surfaces the cheapest upcoming hour beneath the energy section so the user
// can anticipate a good moment for high-load appliances. Returns `null` when
// no upcoming price data exists. Staleness gating is the caller's
// responsibility — `PlanHero` compares `latestFetchedAtMs` against its own
// freshness window before invoking this helper. The caller also decides
// further suppression rules (e.g. when the chip rail already shows a
// `Price low` chip — avoid doubling up).
//
// The unit label is supplied by the caller so this helper stays
// scheme-agnostic (Nordpool øre vs Flow/Homey neutral units).

export type CheapestUpcomingHourInput = {
  hours: ReadonlyArray<{ startsAtMs: number; price: number }>;
  nowMs: number;
  // How far ahead to look. Defaults to 18h so "tonight" and "tomorrow morning"
  // are both eligible without dragging in next-week noise.
  horizonMs?: number;
  unitLabel: string;
  // Divisor to scale a raw per-hour price into the display unit (øre → kr ÷ 100),
  // matching the CostDisplay the smart-task and Budget price surfaces use, so
  // the Overview subline reads `0.32 kr/kWh` — the same unit as those adjacent
  // tabs — instead of a lone `32 øre/kWh`. Defaults to 1 (Flow/Homey neutral
  // units, which are already in display scale).
  divisor?: number;
  // Locale-formatted clock time renderer (`02:00`). Pulled out for testability
  // — the production caller passes the settings-UI locale formatter.
  formatClockTime: (timestampMs: number) => string;
};

const DEFAULT_HORIZON_MS = 18 * 60 * 60 * 1000;

const formatPriceForSubline = (price: number, unitLabel: string): string => {
  // Whole-number øre stay integer-friendly; everything else (the scaled
  // "kr/kWh" the caller now passes for Nordpool, or a Flow/Homey unit) gets two
  // decimals to match the standard pricing convention used across the rest of
  // the UI — "0.32 kr/kWh".
  if (unitLabel.toLowerCase().startsWith('øre')) {
    return `${Math.round(price)} ${unitLabel}`;
  }
  return `${price.toFixed(2)} ${unitLabel}`;
};

export const formatCheapestUpcomingHour = (
  input: CheapestUpcomingHourInput,
): string | null => {
  const horizonMs = input.horizonMs ?? DEFAULT_HORIZON_MS;
  const windowEnd = input.nowMs + horizonMs;
  const upcoming = input.hours.filter((hour) => (
    hour.startsAtMs > input.nowMs && hour.startsAtMs <= windowEnd
  ));
  if (upcoming.length === 0) return null;
  const cheapest = upcoming.reduce((best, hour) => (
    hour.price < best.price ? hour : best
  ));
  const clockText = input.formatClockTime(cheapest.startsAtMs);
  const scaledPrice = cheapest.price / Math.max(1, input.divisor ?? 1);
  const priceText = formatPriceForSubline(scaledPrice, input.unitLabel);
  return `Cheapest hour ahead: ${clockText}, ${priceText}.`;
};
