// Canonical wording for the "daily budget exceeds what your hard cap can
// deliver" banner. Lives in shared-domain so the settings UI banner and any
// future runtime log line emit identical text (Rule 7,
// `notes/ui-terminology.md`).
//
// Terminology: per `notes/ui-terminology.md` § "Safe pace, hard cap, and
// safety margin", the configured upper boundary PELS tries not to exceed is
// **hard cap** — never "hourly limit" / "hourly power limit". And per
// § "Hard cap is physical": the hard cap is a property of the user's grid
// tariff or breaker, so copy must never suggest raising it as a remedy.
// The recommended fix is to lower the daily budget so future days reserve
// available power earlier (see `cannotMeetDailyBudgetExhausted` in
// `deadlineLabels.ts`).

const HARD_CAP_REMEDY = 'Lower the daily budget so PELS can shift usage to cheaper hours.';

export const DAILY_BUDGET_ALLOCATION_WARNING_TITLE
  = 'Daily budget exceeds what your hard cap can deliver';

export const formatDailyBudgetAllocationWarningBody = (
  configuredKWhText: string,
  ceilingKWhText: string | null,
): string => {
  if (ceilingKWhText !== null) {
    return (
      `You've set ${configuredKWhText}, but at most ${ceilingKWhText} fits within your `
      + `hard cap. Lower the daily budget to that or below so PELS can shift usage `
      + 'to cheaper hours.'
    );
  }
  return (
    `You've set a daily budget of ${configuredKWhText}, which is more than your hard cap `
    + `can deliver in a day. ${HARD_CAP_REMEDY}`
  );
};
