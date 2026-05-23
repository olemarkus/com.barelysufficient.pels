// Canonical wording for the Budget panel's hero "did we land?" / "what's left
// today?" decision sentences. The Budget page is the user's canonical
// "should I run loads now?" surface, so any runtime log that quotes the hero
// must pull from the same source — Rule 4 (UI text shared with logs) and
// `notes/ui-terminology.md`.
//
// `composeHeadroomLine` takes pre-formatted kWh / cost text from the caller
// (settings-ui owns `formatKWh` / `formatCost`) and returns the final hero
// subline. Keeping the formatters out of shared-domain avoids dragging
// settings-ui-local utilities into a browser-safe package; the language and
// punctuation stay here.

// Finish-of-day decision sentences for the yesterday view (rendered as the
// hero decision line and the chart subtitle).
export const YESTERDAY_FINISHED_OVER_BUDGET = 'Yesterday finished over budget.';
export const YESTERDAY_FINISHED_WITHIN_BUDGET = 'Yesterday finished within budget.';

// Finish-of-day chart-subtitle sentences for the yesterday view. Distinct from
// the decision-line strings above because the chart subtitle drops the leading
// time anchor ("Yesterday") — the chart title already establishes the day.
export const CHART_FINISHED_OVER_DAILY_BUDGET = 'Finished over the daily budget.';
export const CHART_FINISHED_WITHIN_BUDGET = 'Finished within budget.';

// Today-view headroom-status templates. Caller passes the formatted kWh
// quantity (e.g. `"1.2 kWh"`); shared-domain owns the surrounding language.
export const composeHeadroomOverBudgetUsed = (remainingFormatted: string): string => (
  `${remainingFormatted} over budget already used`
);
export const composeHeadroomLeftToday = (remainingFormatted: string): string => (
  `${remainingFormatted} left in today's budget`
);

// Appends today's estimated-cost suffix to one of the headroom-status lines
// above. Caller passes the formatted cost (e.g. `"6.50 kr"`).
export const composeHeadroomLineWithEstimate = (
  statusLine: string,
  costFormatted: string,
): string => `${statusLine} · est. ${costFormatted} today`;
