/**
 * Aggregate simulation posture across the Main home and the ACTIVE meter
 * areas (multi-home PR 8b). Main's `capacity_dry_run` and each area's
 * `capacity_dry_run:<homeId>` are independent flags, so "is PELS simulating?"
 * has three honest answers once areas exist: everything is live, everything is
 * simulating, or the homes are split. The global simulation banner and the
 * Settings hub chip used to read Main's flag only — silent while a meter area
 * was still simulating, and overclaiming "On" while the areas were live.
 *
 * Resolution lives here (not in the settings UI) so the banner, the hub chip,
 * and any future runtime logging speak the same words for the same state
 * (`feedback_ui_text_shared_with_logs`). Import this module directly — there
 * is no shared-domain barrel.
 *
 * Held (pre-GA) meter areas are the CALLER's concern: their devices still
 * belong to the Main home, so their flags must not be passed in at all.
 */

import { HOMES_MAIN_HOME_NAME, resolveHomeAreaDisplayName } from './homesManagementCopy';

/**
 * `mixed` covers every posture that is honestly neither absolute: homes KNOWN
 * to be split, and an aggregate degraded by an unknown area flag (see
 * `areaSimulating`). Both render the cautious middle (`Partly on` chip).
 */
export type SimulationPosture = 'all_live' | 'all_simulating' | 'mixed';

export type SimulationPostureInput = {
  /** Main home's `capacity_dry_run` flag (true = simulating). */
  mainSimulating: boolean;
  /**
   * One `capacity_dry_run:<homeId>` flag per ACTIVE meter area. `null` marks
   * a flag with no resolved value this session (a transient read failure or a
   * malformed persisted value, with no last-good value to fall back on). An
   * unknown BLOCKS both absolute claims: an aggregate containing an area
   * nobody can vouch for must not say "everything is live" (silencing the
   * chip while that area may simulate) or "everything is simulating"
   * (overclaiming `On` while it may be live). The posture degrades to
   * `mixed` — the cautious middle — until every active area has a resolved
   * flag.
   */
  areaSimulating: ReadonlyArray<boolean | null>;
};

export const resolveSimulationPosture = (
  { mainSimulating, areaSimulating }: SimulationPostureInput,
): SimulationPosture => {
  // An unknown area flag joins neither absolute claim — see the
  // `areaSimulating` contract above.
  if (areaSimulating.some((flag) => flag === null)) return 'mixed';
  const flags = [
    mainSimulating,
    ...areaSimulating.filter((flag): flag is boolean => flag !== null),
  ];
  if (flags.every((simulating) => simulating)) return 'all_simulating';
  if (flags.every((simulating) => !simulating)) return 'all_live';
  return 'mixed';
};

// ── Global simulation banner ───────────────────────────────────────────────

/** The `data-home-scope` claim the banner element carries for tests/styling. */
export type SimulationBannerScope = 'all' | 'main' | 'areas';

export type SimulationBannerContent = {
  text: string;
  /**
   * The banner button's label. `null` hides the button: the area-scoped line
   * has no one-tap remedy here — each area's own control toggle lives on the
   * Limits & safety page, which the text names.
   */
  actionLabel: string | null;
  scope: SimulationBannerScope;
};

/**
 * What the global simulation banner says, or `null` when it has nothing
 * truthful to alert on.
 *
 * - No meter areas: the historical whole-home claim.
 * - Areas exist and Main simulates: the claim narrows to the Main home. Any
 *   simulating area is deliberately NOT appended — the Main claim is the one
 *   the button can act on, and once Main goes live the banner flips to the
 *   area line below on its own.
 * - Areas exist, Main is live, and at least one active area still simulates:
 *   the state the Main-flag-only banner used to hide. Names the one area (or
 *   the count) and the page that holds the control.
 * - `hasMeterAreas === null` (the roster read could not be classified) keeps
 *   the conservative Main-scoped claim: it stays truthful even when malformed
 *   state hides a meter area from the WebView.
 */
export const resolveSimulationBannerContent = (input: {
  hasMeterAreas: boolean | null;
  mainSimulating: boolean;
  /** Raw persisted names of the ACTIVE meter areas currently simulating. */
  simulatingAreaNames: readonly string[];
}): SimulationBannerContent | null => {
  if (input.hasMeterAreas === false) {
    if (!input.mainSimulating) return null;
    return {
      text: 'Simulation on — devices stay as-is',
      actionLabel: 'Turn off simulation',
      scope: 'all',
    };
  }
  if (input.mainSimulating) {
    // The complement is named from the one registered constant, and named the
    // SAME way in both strings: the button used to say bare "Main".
    return {
      text: `${HOMES_MAIN_HOME_NAME} simulation on — ${HOMES_MAIN_HOME_NAME} devices stay as-is`,
      actionLabel: `Turn off ${HOMES_MAIN_HOME_NAME} simulation`,
      scope: 'main',
    };
  }
  const [firstAreaName] = input.simulatingAreaNames;
  if (firstAreaName === undefined) return null;
  const subject = input.simulatingAreaNames.length === 1
    // Self-resolving like the homesManagementCopy composers: the shared
    // blank-name rule applies here so a blank-named area reads "Meter area".
    ? `“${resolveHomeAreaDisplayName(firstAreaName)}”`
    : `${input.simulatingAreaNames.length} meter areas`;
  return {
    text: `PELS is only simulating ${subject}. Turn on control under Limits & safety.`,
    actionLabel: null,
    scope: 'areas',
  };
};
