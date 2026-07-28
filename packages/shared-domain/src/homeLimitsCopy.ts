/**
 * User-facing copy for the per-home "Limits & safety" surface (multi-home U3).
 *
 * Vocabulary (notes/ui-terminology.md): the shell's global scope bar picks the
 * **Main home** or a configured **meter area** (its copy lives in
 * `homeScopeCopy.ts`); this surface edits whichever is selected. The ceiling is
 * the **Hard cap**, the buffer below it the **Safety margin**. The dry-run
 * setting is surfaced as a
 * POSITIVE **"Control devices in this area"** toggle (ON = PELS limits this
 * area, OFF = it only simulates) — never the internal "dry-run" jargon, and
 * never the old OFF-to-activate double-negative. A current config reads
 * **"Simulating"/"Active"**; a held pre-GA config reads **"Not active"** and
 * points the owner to the deliberate save that activates it. Copy says what
 * happens ("let PELS limit devices", "only simulating"), never the planner's
 * shed/restore words.
 *
 * Lives in shared-domain so the settings UI and any future runtime logging
 * speak the same words for the same state (`feedback_ui_text_shared_with_logs`).
 * Import this module directly — there is no shared-domain barrel.
 */

import { resolveHomeAreaDisplayName } from './homesManagementCopy';

// ── Cap + margin fields (units in the label per the style rules) ─────────────

export const HOME_LIMITS_HARD_CAP_LABEL = 'Hard cap (kW)';
export const HOME_LIMITS_HARD_CAP_HINT = 'This meter area’s grid tariff step (effekttrinn) — '
  + 'PELS keeps each hour’s average power under this.';

// The Main-home form's own hard-cap hint, which the static markup ships and
// this module re-owns once meter areas exist. "Your grid tariff step" is true
// for a single-meter home and misleading the moment the house is split: the
// Main home is then one home among several, and a whole-house number typed into
// a subpart's cap is exactly the mistake the scope bar exists to prevent. The
// area branch names its scope three times; the Main branch must name it once.
export const HOME_LIMITS_MAIN_HARD_CAP_HINT = 'Your grid tariff step (effekttrinn) — '
  + 'PELS keeps each hour’s average power under this.';
export const HOME_LIMITS_MAIN_HARD_CAP_HINT_WITH_AREAS = 'The Main home’s grid tariff step '
  + '(effekttrinn) — PELS keeps each hour’s average power under this.';

/**
 * Shown in place of the Power source / Whole-home meter card while a meter area
 * is the selected scope. Neither belongs under an area's scope claim, and
 * neither may simply vanish with no account of where it went.
 *
 * The two are deliberately described SEPARATELY. Power source really is
 * app-wide. The whole-home meter is not: it is the Main home's own meter, and
 * calling it "for the whole home" invites picking an aggregate that also counts
 * the meter areas — which would make Main-home devices react to usage that
 * isn't theirs.
 */
export const HOME_LIMITS_GLOBAL_SETTINGS_ELSEWHERE = 'Power source is set once for all of PELS, '
  + 'and the whole-home meter is the Main home’s own meter. '
  + 'Switch to Main home to change either.';
export const HOME_LIMITS_MARGIN_LABEL = 'Safety margin (kW)';
// Save-time validation copy. Byte-aligned with the Main-home form's messages
// (`capacity.ts`); duplicated deliberately — importing shared-domain into the
// stable Main-home path would change that byte-identical surface, so the two
// stay in step by convention (the notes/ui-terminology copy-origin rule yields
// here to the byte-identical-main constraint).
export const HOME_LIMITS_MARGIN_TOO_HIGH
  = 'Safety margin must be less than the hard cap. Lower the margin to continue.';
export const HOME_LIMITS_HARD_CAP_POSITIVE = 'Hard cap must be positive.';
export const HOME_LIMITS_HARD_CAP_MAX = 'Hard cap cannot exceed 1000 kW.';
export const HOME_LIMITS_MARGIN_NEGATIVE = 'Safety margin must be non-negative.';

/** Computed-ceiling readout row (mirrors the Main-home form's result row). */
export const HOME_LIMITS_REACTION_LABEL = 'With these settings, safe pace starts each hour at';
export const HOME_LIMITS_REACTION_NOTE = '(hard cap minus safety margin; it adapts as the hour is used)';

// ── Control (the activation affordance) ─────────────────────────────────────
//
// A POSITIVE toggle: ON = PELS controls (limits) this meter area's devices, OFF
// = it only simulates. Green (on) therefore means the same thing here as the
// "Active" status chip — live control — instead of the old double-negative
// "Simulation mode" switch you turned OFF to activate. A meter area ships OFF
// (simulating), so turning this ON is exactly the step that starts control.

export const HOME_LIMITS_CONTROL_LABEL = 'Control devices in this area';
export const HOME_LIMITS_CONTROL_HINT
  = 'When on, PELS limits devices in this meter area to keep each hour under its cap.';
export const HOME_LIMITS_INACTIVE_CHIP = 'Not active';
export const HOME_LIMITS_INACTIVE_STATUS
  = 'Open Multiple meters and save this area to start using these settings.';

/**
 * The unmissable activation notice, shown only while the selected meter area is
 * OFF (simulating). Consequence-first ("only simulating"), then the remedy that
 * names the real toggle right above it ("turn on control").
 */
// Self-resolving like the homesManagementCopy composers: callers pass the raw
// persisted area name and the shared blank-name rule is applied here, so a
// blank-named area reads “Meter area”, never an empty quotation.
export const composeHomeLimitsSimulationNotice = (name: string): string => (
  `PELS is only simulating “${resolveHomeAreaDisplayName(name)}” — `
  + 'turn on control to let it limit devices in this meter area.'
);

/** A held pre-GA area needs an explicit owner save before any per-area control can start. */
export const composeHomeLimitsInactiveNotice = (name: string): string => (
  `PELS isn’t using “${resolveHomeAreaDisplayName(name)}” yet — `
  + 'open Multiple meters and save this area before turning on control.'
);

// ── Save toasts ─────────────────────────────────────────────────────────────

export const HOME_LIMITS_SAVED_TOAST = 'Limits & safety saved.';
export const HOME_LIMITS_SAVE_FAILED_TOAST = 'Failed to save limits & safety.';
export const HOME_LIMITS_CONTROL_SAVED_TOAST = 'Control setting updated.';
export const HOME_LIMITS_CONTROL_FAILED_TOAST = 'Failed to update control setting.';
export const HOME_LIMITS_LOAD_FAILED_TOAST = 'Couldn’t load limits for this meter area.';

// ── Placeholder ─────────────────────────────────────────────────────────────

/** Stable dash for an unresolved figure (kept so a value slot is never empty). */
export const HOME_LIMITS_VALUE_PLACEHOLDER = '—';
