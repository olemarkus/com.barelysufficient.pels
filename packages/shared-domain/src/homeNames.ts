/**
 * The canonical names PELS gives the parts of a home, and the one rule for
 * rendering a saved meter-area name.
 *
 * DEPENDENCY-NEUTRAL LEAF — this module imports NOTHING, and must keep
 * importing nothing. It exists because both halves of the "Multiple meters"
 * surface need these names: the validation side (`homesManagement.ts`, and
 * `homeAreaConfigRules.ts` which it value-imports) and the copy side
 * (`homesManagementCopy.ts`, `homeLimitsCopy.ts`, `simulationPosture.ts`),
 * while the copy module already depends on the validation module for its
 * error/warning types. Holding the names anywhere on the copy side therefore
 * closes a cycle — directly (validation → copy) or one hop longer
 * (validation → rules → copy) — and root AGENTS.md forbids cycles. Note that
 * the type-only back-edge is erased before dependency-cruiser sees it, so
 * `arch:check` cannot be relied on to catch a reintroduced cycle here —
 * `test/integration/homeNamesLeafModule.test.ts` guards the leaf instead.
 *
 * Lives in shared-domain so the settings UI and the runtime speak the same
 * words for the same state (`feedback_ui_text_shared_with_logs`).
 * Import this module directly — there is no shared-domain barrel.
 */

/**
 * The implicit complement's display name (notes/ui-terminology.md). Canonical
 * for every surface that names a home, including runtime Flow tokens, so a
 * Flow tag reads exactly like the settings label.
 */
export const HOMES_MAIN_HOME_NAME = 'Main home';

/**
 * Stand-in when a saved meter area carries an empty name. Persisted names are
 * untrusted (any string), and a blank Flow tag or status line would tell the
 * owner nothing about which part of the home it came from.
 */
export const HOMES_UNNAMED_AREA_NAME = 'Meter area';

/**
 * The name to SHOW for a meter area. Persisted names are untrusted: the config
 * store accepts any string and the save path does not check the name either, so
 * a blank one is reachable. One rule for every surface that renders an area
 * name (the Multiple meters list, the shortfall Flow tag, the runtime logs) so
 * a blank area is not an empty row on one screen and `Meter area` on the next.
 * Takes the raw name rather than a config object so both the settings UI and
 * the runtime can call it.
 */
export const resolveHomeAreaDisplayName = (name: string): string => (
  name.trim() || HOMES_UNNAMED_AREA_NAME
);
