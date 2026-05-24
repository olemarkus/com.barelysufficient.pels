// Canonical wording for the Budget panel's hero "did we land?" / "what's left
// today?" decision sentences, plus the supporting headline labels and chart
// subtitles. The Budget page is the user's canonical "should I run loads now?"
// surface, so any runtime log that quotes the hero must pull from the same
// source — Rule 4 (UI text shared with logs) and `notes/ui-terminology.md`.
//
// The compose-* helpers take pre-formatted kWh / cost text from the caller
// (settings-ui owns `formatKWh` / `formatCost`) and return the final hero
// subline. Keeping the formatters out of shared-domain avoids dragging
// settings-ui-local utilities into a browser-safe package; the language and
// punctuation stay here.

// Status / view discriminants used by the resolvers below. Mirror the
// settings-ui aliases (`BudgetStatus`, `BudgetRedesignDayView`,
// `BudgetRedesignChartMode`, `DominantCause`) without importing them — the
// settings-ui types can `=` these to keep both sides in lockstep.
export type DailyBudgetHeroStatus = 'noPlan' | 'within' | 'tight' | 'over';
export type DailyBudgetHeroDayView = 'today' | 'tomorrow' | 'yesterday';
export type DailyBudgetHeroChartMode = 'progress' | 'hourlyPlan';
export type DailyBudgetHeroDominantCause = 'managed' | 'background';

// Finish-of-day decision sentences for the yesterday view (rendered as the
// hero decision line and the chart subtitle).
export const YESTERDAY_FINISHED_OVER_BUDGET = 'Yesterday finished over budget.';
export const YESTERDAY_FINISHED_WITHIN_BUDGET = 'Yesterday finished within budget.';

// Finish-of-day chart-subtitle sentences for the yesterday view. Distinct from
// the decision-line strings above because the chart subtitle drops the leading
// time anchor ("Yesterday") — the chart title already establishes the day.
export const CHART_FINISHED_OVER_DAILY_BUDGET = 'Finished over the daily budget.';
export const CHART_FINISHED_WITHIN_BUDGET = 'Finished within budget.';

// Hero headline labels per day view. The today label is "Projected today"
// because the figure is a projection, not a used-so-far reading.
export const DAILY_BUDGET_HEADLINE_LABEL_BY_VIEW: Record<DailyBudgetHeroDayView, string> = {
  yesterday: "Yesterday's total",
  today: 'Projected today',
  tomorrow: 'Planned for tomorrow',
};

// Disabled / waiting comparison strings shown in place of the kWh comparison
// line when the budget feature is off or the payload has not arrived yet.
export const DAILY_BUDGET_DISABLED_WAITING = 'Waiting for daily budget data';
export const DAILY_BUDGET_DISABLED_OFF = 'Daily budget off';

// Hero delta-pill labels for the today / tomorrow comparison row. The
// `composeBudgetHeroOverBy` helper owns its own kWh formatting (one decimal)
// so the runtime logger can quote the exact pill label without re-importing
// the settings-ui-local `formatKWh`. Mirrors the `formatComparisonKWh` shape
// used in `budgetRedesignResolvers.ts`.
export const BUDGET_HERO_CLOSE_TO_BUDGET = 'Close to budget';
export const BUDGET_HERO_ON_BUDGET = 'On budget';
const formatBudgetHeroKWh = (value: number): string => (
  Number.isFinite(value) ? value.toFixed(1) : '--'
);
export const composeBudgetHeroOverBy = (kwh: number): string => (
  `Over by ${formatBudgetHeroKWh(kwh)} kWh`
);

// Price-shaping tagline shown beneath the hero comparison when the feature is
// on. The "no prices" variant only differs in the parenthetical disclaimer.
export const BUDGET_HERO_USING_CHEAPER_HOURS = 'Using cheaper hours';
export const BUDGET_HERO_USING_CHEAPER_HOURS_NO_PRICES = 'Using cheaper hours (price data unavailable)';

// Today-view split-line that names managed vs background kWh totals. The
// helper formats both numbers to one decimal (matching the prior settings-ui
// `formatKWh(value, 1)` call) so a runtime logger that quotes the line gets
// byte-identical output.
export const composeManagedBackgroundLine = (
  managedKWh: number,
  backgroundKWh: number,
): string => {
  const managed = Number.isFinite(managedKWh) ? `${managedKWh.toFixed(1)} kWh` : '-- kWh';
  const background = Number.isFinite(backgroundKWh) ? `${backgroundKWh.toFixed(1)} kWh` : '-- kWh';
  return `Managed ${managed} · Background ${background}`;
};

// Today-view budget-status templates. Caller passes the formatted kWh
// quantity (e.g. `"1.2 kWh"`); shared-domain owns the surrounding language.
export const composeBudgetUsedOver = (remainingFormatted: string): string => (
  `${remainingFormatted} over budget already used`
);
export const composeBudgetRemainingToday = (remainingFormatted: string): string => (
  `${remainingFormatted} left in today's budget`
);

// Appends today's estimated-cost suffix to one of the budget-status lines
// above. Caller passes the formatted cost (e.g. `"6.50 kr"`). The word
// "estimated" stays spelled out — Rule 3 (`notes/ui-terminology.md`) bans
// abbreviations in visible labels, including the prior `est.` shorthand.
export const composeBudgetRemainingLineWithEstimate = (
  statusLine: string,
  costFormatted: string,
): string => `${statusLine} · estimated ${costFormatted} today`;

// Today-tone decision line. Silent on `within`; otherwise names the dominant
// cause so the user knows whether to look at background load or managed
// devices.
export const resolveTodayLine = (
  status: DailyBudgetHeroStatus,
  cause: DailyBudgetHeroDominantCause,
): string | null => {
  if (status === 'within') return null;
  if (status === 'tight') {
    return cause === 'background'
      ? 'Close to budget — driven by background usage.'
      : 'PELS is shaping flexible use to stay within budget.';
  }
  return cause === 'background'
    ? 'Background usage is higher than expected today.'
    : 'Managed devices used more than expected — check device priorities.';
};

// Chart titles for the progress / hourly-plan toggle. Both labels are used
// twice in settings-ui: once as the chart card heading (driven by
// `resolveChartData` in `budgetRedesignResolvers.ts`) and once as the
// ToggleGroup option labels in `BudgetOverview.tsx`. Lifting them keeps the
// two call sites — and any runtime log quoting the chart heading — in lockstep.
export const BUDGET_CHART_TITLE_HOURLY_PLAN = 'Hourly plan';
export const BUDGET_CHART_TITLE_PROGRESS = 'Progress';

// Plan-confidence band labels rendered in the hero confidence card and the
// expanded confidence detail rows. The label values are also part of
// `BudgetConfidenceData['label']`, so re-exporting them as constants lets the
// settings-ui type narrow to a literal union built from the shared-domain
// source instead of duplicating the spellings.
export const BUDGET_CONFIDENCE_LABEL_HIGH = 'High';
export const BUDGET_CONFIDENCE_LABEL_MEDIUM = 'Medium';
export const BUDGET_CONFIDENCE_LABEL_LOW = 'Low';
export type BudgetConfidenceLabel =
  | typeof BUDGET_CONFIDENCE_LABEL_HIGH
  | typeof BUDGET_CONFIDENCE_LABEL_MEDIUM
  | typeof BUDGET_CONFIDENCE_LABEL_LOW;

// Adjust-vs-active comparison labels shown above the side-by-side budget
// charts. Both strings preserve the original em-dash continuation so a runtime
// logger can quote them verbatim. The "tomorrow" form is selected when both
// payloads have reliable tomorrow prices (see `resolveComparisonDay`); the
// "today" form is the fallback.
export const BUDGET_COMPARISON_SHOWING_TOMORROW = 'Showing tomorrow’s plan — tomorrow’s prices are in.';
export const BUDGET_COMPARISON_SHOWING_TODAY = 'Showing today’s plan — tomorrow’s prices not yet available.';

// Allocation-warning banner action label. Rendered as the `MdTextButton`
// inside `AllocationWarningBanner` (`BudgetOverview.tsx`); lifted so the same
// wording can be referenced from runtime logs without duplicating the literal.
export const BUDGET_ADJUST_BUDGET_BUTTON = 'Adjust budget';

// No-plan decision lines shown in place of the today/tomorrow/yesterday hero
// decision sentence when the day payload is missing or the planner has not
// produced anything yet. Split per (budget-enabled × view) discriminant so the
// resolver below stays a pure router. The `..._ENABLE_FOR_*` forms surface
// when the daily-budget feature is off and the user needs to be nudged to
// enable it.
export const BUDGET_NO_PLAN_TOMORROW_WAITING
  = "Tomorrow's plan is not available yet. Check electricity prices if it does not appear shortly.";
export const BUDGET_NO_PLAN_YESTERDAY_WAITING = 'Yesterday history is not available yet.';
export const BUDGET_NO_PLAN_TODAY_PREPARING = 'PELS is preparing the daily plan. Check again shortly.';
export const BUDGET_NO_PLAN_ENABLE_FOR_TOMORROW = 'Enable daily budget to plan tomorrow.';
export const BUDGET_NO_PLAN_ENABLE_FOR_TODAY = 'Enable daily budget to build a daily plan.';

// Resolver for the no-plan decision line. The view × budgetEnabled matrix
// produces five distinct sentences (see constants above); the consumer just
// passes its discriminants and gets the finished string back so a runtime log
// can quote the same wording without re-implementing the branch tree.
export const resolveNoPlanLine = (
  view: DailyBudgetHeroDayView,
  budgetEnabled: boolean,
): string => {
  if (budgetEnabled && view === 'tomorrow') return BUDGET_NO_PLAN_TOMORROW_WAITING;
  if (budgetEnabled && view === 'yesterday') return BUDGET_NO_PLAN_YESTERDAY_WAITING;
  if (budgetEnabled) return BUDGET_NO_PLAN_TODAY_PREPARING;
  if (view === 'tomorrow') return BUDGET_NO_PLAN_ENABLE_FOR_TOMORROW;
  return BUDGET_NO_PLAN_ENABLE_FOR_TODAY;
};

// Tomorrow-view decision line. Two variants depending on whether the planner
// could shape spend toward cheaper hours: the shaped form names the price
// signal, the fallback only announces readiness. The resolver below routes on
// `priceShapingActive` (consumer combines `isPriceReliable(payload)` with
// `payload.budget.priceShapingEnabled`) so the producer owns the wording and
// any runtime log can reuse the helper without recomputing the predicate.
export const BUDGET_TOMORROW_PRICE_SHAPED = 'Most planned use is shifted toward cheaper hours.';
export const BUDGET_TOMORROW_PLAN_READY = "Tomorrow's budget plan is ready.";
export const resolveTomorrowLine = (priceShapingActive: boolean): string => (
  priceShapingActive ? BUDGET_TOMORROW_PRICE_SHAPED : BUDGET_TOMORROW_PLAN_READY
);

// Chart subtitle for the progress / hourly-plan charts. Mirrors the
// `resolveDecisionLine` taxonomy but with chart-specific phrasing that drops
// the time anchor (the chart title already names the day).
export const resolveChartSubtitle = (params: {
  view: DailyBudgetHeroDayView;
  mode: DailyBudgetHeroChartMode;
  status: DailyBudgetHeroStatus;
  priceReliable: boolean;
  priceShapingEnabled: boolean;
}): string => {
  const { view, mode, status, priceReliable, priceShapingEnabled } = params;
  if (mode === 'hourlyPlan') {
    if (priceReliable && priceShapingEnabled) return 'Budget follows cheaper hours.';
    if (priceShapingEnabled) return 'Cheaper-hour context needs price data.';
    return 'Shows how the budget is distributed through the day.';
  }
  if (view === 'yesterday') {
    return status === 'over' ? CHART_FINISHED_OVER_DAILY_BUDGET : CHART_FINISHED_WITHIN_BUDGET;
  }
  if (view === 'tomorrow') return 'Shows the planned cumulative budget.';
  if (status === 'over') return 'Projected to finish over budget.';
  if (status === 'tight') return 'Close to the daily budget.';
  return 'On track to finish within budget.';
};
