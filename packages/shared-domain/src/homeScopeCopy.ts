/**
 * User-facing copy for the shell's global home scope bar (multi-home).
 *
 * Vocabulary (notes/ui-terminology.md § "Multiple meters vocabulary"): the bar
 * names which part of the home the page is about — the **Main home** or a
 * configured **meter area**. The lead word is `Showing`, so the bar reads as a
 * plain statement of what is on screen ("Showing Rental unit") rather than a
 * settings field. Internal words (`sub-home`, `homeId`, `scope`) never surface.
 *
 * Lives in shared-domain so the settings UI and any future runtime logging
 * speak the same words for the same state (`feedback_ui_text_shared_with_logs`).
 * Import this module directly — there is no shared-domain barrel.
 */

import { HOME_LIMITS_CONTROL_LABEL } from './homeLimitsCopy';

/** Lead word before the selected home's name: "Showing [Main home ▾]". */
export const HOME_SCOPE_BAR_LABEL = 'Showing';


/**
 * The implicit complement — everything not in a meter area. Re-exported from
 * the canonical Multiple-meters constant (`HOMES_MAIN_HOME_NAME`, established
 * for the Limits switcher, the meter-clash refusal and the `capacity_shortfall`
 * Flow token), so the scope bar cannot drift to a second spelling of one home.
 */
export { HOMES_MAIN_HOME_NAME as MAIN_HOME_NAME } from './homesManagementCopy';

/**
 * Appends the home to a title that would otherwise read as whole-home, e.g.
 * `Status now · Rental unit`. Reserved for labels the app also uses UNSCOPED
 * elsewhere — the Limits status card reuses the Overview's `Power now`, so
 * without this the same words would name two different homes on two screens.
 *
 * NOT for page titles. The scope bar is sticky, so the home is already on
 * screen at every scroll position; appending it to the panel's app bar too put
 * an untruncated name directly above a truncated copy of itself.
 */
export const composeHomeScopedTitle = (title: string, homeName: string): string => (
  `${title} · ${homeName}`
);

/**
 * Usage-tab honest state when the selected part of the home cannot be served
 * (`homeScope: unavailable` — a held or just-removed area, or a runtime still
 * wiring up). The data sections hide behind this notice instead of rendering
 * zeros: a fabricated `0.0 kWh today` would read as a measurement. "Part of
 * the home" is the scope bar's own phrase; internal words (`scope`,
 * `sub-home`, `unavailable`) never surface.
 */
export const HOME_SCOPE_USAGE_UNAVAILABLE_HEADLINE = 'Usage couldn’t be read';

export const HOME_SCOPE_USAGE_UNAVAILABLE_BODY = 'PELS couldn’t read usage for this part of the home right now. '
  + 'Check back in a moment, or pick another part of the home above.';

/**
 * Overview honest state when the selected part of the home cannot be served
 * (`homeScope: unavailable`). Same contract as the Usage notice above: the
 * hero and device cards hide behind this card instead of rendering fabricated
 * numbers — a `0.0 kW` hero would answer "am I OK right now?" with a
 * measurement nobody took.
 */
export const HOME_SCOPE_OVERVIEW_UNAVAILABLE_HEADLINE = 'Status couldn’t be read';

export const HOME_SCOPE_OVERVIEW_UNAVAILABLE_BODY = 'PELS couldn’t read the current status for this part of the home '
  + 'right now. Check back in a moment, or pick another part of the home above.';

// ── Honest scope / not-supported-yet states (multi-home locked decision 1) ──
//
// Surfaces that do NOT follow the shell's home picker say so once meter areas
// are in use: a Main-home page carries a scope line naming the Main home, and
// a feature that does not cover meter areas yet says so explicitly instead of
// serving an empty payload that reads as healthy. All four strings render only
// while at least one ACTIVE meter area exists (`areMeterAreasInUse`) — for a
// single-meter home, and for a held pre-GA config whose devices still belong
// to the Main home, every one of them would be noise.

/**
 * Budget tab scope line. The daily budget is a MAIN-HOME budget (locked
 * decision 3): `createDailyBudgetService` binds the Main home's tracker and
 * capacity, so once areas run on their own meters the budget plans and
 * measures the Main home only. No aggregation exists, so the line must say
 * "Main home", never "whole home".
 */
export const HOME_SCOPE_BUDGET_MAIN_ONLY_LINE = 'Your daily budget covers the Main home. '
  + 'Each meter area runs on its own cap and isn’t counted here.';

/**
 * Smart tasks list notice (locked decision 4): smart tasks are refused on a
 * device that lives in a meter area, so the page says so up front rather than
 * letting the refusal be the first signal.
 */
export const HOME_SCOPE_SMART_TASKS_MAIN_ONLY_NOTICE = 'Smart tasks run on Main home devices. '
  + 'A device in a meter area can’t have a smart task yet.';

/**
 * Device-detail honest states for a device that belongs to a meter area
 * (locked decision 5): the diagnostics recorder and the activity log are the
 * Main home's, so for an area device both sections would serve an empty
 * payload that reads as healthy ("No diagnostics recorded yet"). Say what is
 * actually true — not measured yet — and that normal control is unaffected.
 */
export const HOME_SCOPE_DIAGNOSTICS_NOT_MEASURED = 'Not measured for meter areas yet. '
  + 'PELS limits and resumes this device normally, but doesn’t record diagnostics for it yet.';

export const HOME_SCOPE_ACTIVITY_NOT_RECORDED = 'Not recorded for meter areas yet. '
  + 'PELS limits and resumes this device normally, but doesn’t keep an activity log for it yet.';

/**
 * Simulation-mode settings page scope note. The page carries only the Main
 * home's switch, yet the Settings hub's `Partly on` chip routes here for any
 * split posture — so the page must name where the rest of the control lives.
 * Composed from the real toggle's label so the pointer cannot drift from the
 * control it names.
 */
export const HOME_SCOPE_SIMULATION_MAIN_ONLY_NOTE = 'This switch covers the Main home. '
  + `Each meter area has its own “${HOME_LIMITS_CONTROL_LABEL}” switch, under Limits & safety.`;
