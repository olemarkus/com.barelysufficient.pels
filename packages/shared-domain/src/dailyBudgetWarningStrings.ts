import type { PowerLimitAxis } from '../../contracts/src/capacitySettings';

// Canonical wording for the "daily budget exceeds what your hard cap can
// deliver" banner. Lives in shared-domain so the settings UI banner and any
// future runtime log line emit identical text (Rule 7,
// `notes/ui-terminology.md`).
//
// Terminology: per `notes/ui-terminology.md` § "Safe pace, hard cap, and
// safety margin", the configured hourly-average ceiling (grid tariff step) is
// **hard cap** — never "hourly limit" / "hourly power limit". And per
// § "Hard cap is an hourly ceiling": the hard cap is the user's grid tariff
// step (an hourly-average ceiling), so copy must never suggest raising it as
// a remedy.
// The recommended fix is to lower the daily budget so future days reserve
// available power earlier (see `cannotMeetDailyBudgetExhausted` in
// `deadlineLabels.ts`).
//
// The banner names the limit that sets the day's ceiling
// (`DailyBudgetPowerLimitCeiling.limit`): with Capacity limit off, or a grid
// import limit below the hard cap minus its safety margin, that limit is the
// **Grid import limit**, and saying "hard cap" would name a ceiling that is not
// binding (`notes/ui-terminology.md` § "Grid import limit and optional capacity
// control"). Neither limit is offered as something to raise.

const BUDGET_REMEDY = 'Lower the daily budget so PELS can shift usage to cheaper hours.';

const LIMIT_NAME_BY_AXIS: Record<PowerLimitAxis, string> = {
  capacity: 'hard cap',
  grid: 'grid import limit',
};

export const DAILY_BUDGET_ALLOCATION_WARNING_TITLE_BY_LIMIT: Record<PowerLimitAxis, string> = {
  capacity: 'Daily budget exceeds what your hard cap can deliver',
  grid: 'Daily budget exceeds what your grid import limit can deliver',
};

export const formatDailyBudgetAllocationWarningBody = (
  limit: PowerLimitAxis,
  configuredKWhText: string,
  ceilingKWhText: string | null,
): string => {
  const limitName = LIMIT_NAME_BY_AXIS[limit];
  if (ceilingKWhText !== null) {
    return (
      `You've set ${configuredKWhText}, but at most ${ceilingKWhText} fits within your `
      + `${limitName}. Lower the daily budget to that or below so PELS can shift usage `
      + 'to cheaper hours.'
    );
  }
  return (
    `You've set a daily budget of ${configuredKWhText}, which is more than your ${limitName} `
    + `can deliver in a day. ${BUDGET_REMEDY}`
  );
};

// The daily budget field's recommended maximum: the planning ceiling over a day,
// named by the limit that sets it. The hard cap keeps its established
// "safe pace × 24h" gloss (the Limits page shows that period-start pace); the grid
// import limit is not a safe pace, so it is named outright. With no power limit
// enabled there is no ceiling and no recommendation.
export const formatRecommendedMaxHint = (limit: PowerLimitAxis, maxKWhText: string): string => (
  limit === 'capacity'
    ? ` Recommended up to ${maxKWhText} (safe pace × 24h).`
    : ` Recommended up to ${maxKWhText}, what your grid import limit allows in a day.`
);
