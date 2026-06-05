import { formatRelativeTime } from './planFormatUtils.ts';

export type PlanHeroMetaInput = {
  totalKw?: number;
  softLimitKw?: number;
  headroomKw?: number;
  hardCapLimitKw?: number | null;
  hardCapHeadroomKw?: number | null;
  controlledKw?: number;
  uncontrolledKw?: number;
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  lastPowerUpdateMs?: number;
};

export type PowerFreshnessState = 'fresh' | 'stale_hold' | 'stale_fail_closed';

export type HeroTone = 'ok' | 'warn' | 'alert';

export type HeroHeadline = {
  totalKw: number;
  softLimitKw: number;
  hardLimitKw: number | null;
  controlledKw: number | null;
  uncontrolledKw: number | null;
  headroomKw: number;
  overSoftLimit: boolean;
  overHardLimit: boolean;
  kwText: string;
  limitText: string;
  message: string;
  tone: HeroTone;
  ageText: string | null;
};

export type FreshnessChipView = {
  kind: PowerFreshnessState;
  label: string;
  tone: HeroTone;
};

const resolveTone = (overSoftLimit: boolean, overHardLimit: boolean): HeroTone => {
  if (overHardLimit) return 'alert';
  if (overSoftLimit) return 'warn';
  return 'ok';
};

const resolveMessage = (params: {
  headroomKw: number;
  overSoftLimit: boolean;
  overHardLimit: boolean;
  capacityShortfall: boolean;
}): string => {
  const { headroomKw, overSoftLimit, overHardLimit, capacityShortfall } = params;
  if (overHardLimit) return 'Above hard cap';
  if (overSoftLimit) return 'Above safe pace';
  if (capacityShortfall) return 'Keeping power under the hard cap';
  const spare = Math.max(0, headroomKw);
  return `${spare.toFixed(1)} kW to spare`;
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

  const hardCapLimitKw = typeof meta.hardCapLimitKw === 'number' ? meta.hardCapLimitKw : null;
  const hardCapHeadroomKw = typeof meta.hardCapHeadroomKw === 'number' ? meta.hardCapHeadroomKw : null;
  const hardLimitKw = hardCapLimitKw;
  const overSoftLimit = headroomKw < 0;
  const overHardLimit = hardCapHeadroomKw !== null && hardCapHeadroomKw < 0;
  const tone = resolveTone(overSoftLimit, overHardLimit);
  const message = resolveMessage({
    headroomKw,
    overSoftLimit,
    overHardLimit,
    capacityShortfall: meta.capacityShortfall === true,
  });
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
    overHardLimit,
    kwText: `${totalKw.toFixed(1)} kW`,
    limitText: `of ${softLimitKw.toFixed(1)} kW limit`,
    message,
    tone,
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
 */
export const formatProjectedEnergySubline = (projectedKWh: number | null): string | null => {
  if (projectedKWh === null) return null;
  return `projected ${projectedKWh.toFixed(2)} kWh`;
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
  // Concise legend label, no value — e.g. "Safe pace".
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
    return { short: 'Hard cap', aria: `Hard cap ${formatKw(valueKw)}` };
  }
  return { short: 'Safe pace', aria: `Safe pace now ${formatKw(valueKw)}` };
};

export const formatEnergyMeterMarkerLabels = (
  kind: 'target' | 'projected',
  valueKWh: number,
): HeroMeterMarkerLabels => {
  if (kind === 'projected') {
    return {
      short: 'Projected this hour',
      aria: `Projected this hour ${formatKWh(valueKWh)}`,
    };
  }
  return { short: 'Budget this hour', aria: `Budget this hour ${formatKWh(valueKWh)}` };
};

// ─── Above-safe-pace / above-hard-cap subline ────────────────────────────────
// `headroomKw` is the spare room before safe pace (negative when above).
// `hardCapHeadroomKw` is the spare room before hard cap (negative when above).
// The subline copy matches `notes/overview-hero-spec.md` § "Power now" and is
// rendered when the chip indicates the hero is above one of the thresholds.

// Keep the safe-pace numeric reference visible in the above-safe-pace state so
// the user can compare "how much over" against the actual target. Spec:
// `notes/overview-hero-spec.md` § "Power now".
export const formatAboveSafePaceSubline = (headroomKw: number, safePaceKw: number): string => {
  const overshootKw = Math.max(0, -headroomKw);
  return `${formatKw(overshootKw)} above safe pace (${formatKw(safePaceKw)})`;
};

export const formatAboveHardCapSubline = (
  hardCapHeadroomKw: number,
  hardCapKw: number,
): string => {
  const overshootKw = Math.max(0, -hardCapHeadroomKw);
  return `${formatKw(overshootKw)} above hard cap (${formatKw(hardCapKw)})`;
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
): number => {
  const overshoot = Math.max(projectedKWh ?? 0, usedKWh);
  if (overshoot <= budgetKWh) return budgetKWh;
  return overshoot * 1.05;
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
  overHardLimit: boolean;
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
  // 'active'`) that PELS could yet ease off. When this is zero while above the
  // hard cap, the managed shed cascade is exhausted — the only remaining draw
  // is whatever PELS cannot touch.
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

// Resolve the above-hard-cap decision sentence (rule 2 of
// `buildDecisionSentence`). When the managed shed cascade is exhausted (no
// controllable managed device left running to ease off) and the remaining
// breach is attributed to a device with Power-limit control turned off, PELS
// has finished mitigating: claiming it is still "easing devices off"
// overpromises action it cannot take. This is the producer-resolved flag — the
// honest story names the real control and the user's recourse (the hard cap is
// physical and is never offered as a remedy). Extracted so the rule ladder
// stays under the SonarJS / ESLint cognitive-complexity cap.
const resolveOverHardCapDecisionSentence = (
  input: DecisionSentenceInput,
): DecisionSentenceResult => {
  const capacityControlOffCount = input.capacityControlOffCount ?? 0;
  const sheddableManagedRunningCount = input.sheddableManagedRunningCount ?? 0;
  const managedCascadeExhausted = capacityControlOffCount > 0 && sheddableManagedRunningCount === 0;
  if (!managedCascadeExhausted) {
    return { text: 'Over the hard cap right now. Easing devices off.', positive: false };
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

  // 2. Above hard cap.
  if (input.overHardLimit) return resolveOverHardCapDecisionSentence(input);

  // 3. Simulation mode would act.
  if (input.dryRun && input.limitedCount > 0) {
    return {
      text: `${formatDevices(input.limitedCount)} would be limited if simulation mode were off.`,
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
  // Locale-formatted clock time renderer (`02:00`). Pulled out for testability
  // — the production caller passes the settings-UI locale formatter.
  formatClockTime: (timestampMs: number) => string;
};

const DEFAULT_HORIZON_MS = 18 * 60 * 60 * 1000;

const formatPriceForSubline = (price: number, unitLabel: string): string => {
  // Norwegian øre values are integer-friendly (whole-number øre); everything
  // else (e.g. "kr/kWh") gets two decimals to match the standard pricing
  // convention used across the rest of the UI — "1.20 kr/kWh".
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
  const priceText = formatPriceForSubline(cheapest.price, input.unitLabel);
  return `Cheapest hour ahead: ${clockText}, ${priceText}.`;
};
