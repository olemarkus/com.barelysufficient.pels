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
