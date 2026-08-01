/**
 * Config rules for meter areas: the caps and name rules a SAVED area must
 * satisfy, not merely the ones the editor draft checks.
 *
 * Why a shared module: the runtime save seam (`setup/homeMeterOwnership.ts`)
 * is the enforcement and the settings UI renders the refusal, so both sides
 * must speak one set of rules and one set of words
 * (`feedback_ui_text_shared_with_logs`). Pure and browser-safe.
 *
 * Names are load-bearing, not cosmetic. An area name is the label the home
 * selector shows and the value the `capacity_shortfall` Flow token carries, so
 * an empty, duplicate, unbounded, or "Main home" name would stop the very
 * surfaces that read it from telling one home from another. The editor already
 * validates non-emptiness and uniqueness for UX (`homesManagement.ts`); these
 * rules are the persisted-config invariant behind it.
 */

// The Limits switcher (and its `HOME_LIMITS_MAIN_HOME_OPTION` alias) was retired
// by the global scope bar; reserve the canonical spelling directly.
import { HOMES_MAIN_HOME_NAME } from './homeNames';

/**
 * How many meter areas one Homey may configure through the save seam. Each
 * area is its own capacity bundle (plan engine, executor, tracker, timers)
 * inside the app's ~30 MB RSS headroom, and the physical thing being modelled
 * (a rental unit, an annex, a cabin) does not come by the dozen.
 *
 * A WRITE-PATH convention, not a runtime bound: neither the registry nor
 * `normalizeHomesConfig` caps anything, so a `homes_config` written outside
 * the UI still spawns one bundle per area. Enforcing it where the memory is
 * actually consumed is tracked in TODO.md.
 *
 * It bounds GROWTH only. A config already over the cap can still be repaired
 * (rename, re-meter, re-zone) without deleting an area first; refusing that
 * would be a dead end the cap buys nothing for.
 */
export const HOME_AREA_MAX_COUNT = 8;

/**
 * Longest area name the save seam accepts. Comfortably longer than any
 * plausible name ("Downstairs rental apartment" is 27), short enough that the
 * home selector's option, the `capacity_shortfall` Flow token and the
 * per-shortfall log field stay bounded.
 *
 * Bounded going FORWARD only: a longer name already in `homes_config` keeps
 * reaching those consumers until its area is next saved, because the rule runs
 * on the entry being written (see `findHomeAreaNameRejection`).
 */
export const HOME_AREA_NAME_MAX_LENGTH = 40;

/**
 * Names an area may not take. The Main home's own label is the one entry: it
 * names the complement (everything NOT in a meter area), so an area wearing it
 * would make the home selector and the `capacity_shortfall` Flow token stop
 * discriminating the two, which is exactly what the token was added for.
 *
 * Sourced from the canonical Multiple-meters constant rather than respelled,
 * so renaming the Main home in one place cannot leave a stale reservation
 * behind.
 */
export const RESERVED_HOME_AREA_NAMES: readonly string[] = [HOMES_MAIN_HOME_NAME];

/** Why the area name being written cannot be saved. */
export type HomeAreaNameRejection =
  | { reason: 'name_required' }
  | { reason: 'name_too_long'; maxLength: number }
  | { reason: 'name_reserved'; reservedName: string }
  | { reason: 'name_duplicate'; otherName: string };

/**
 * Boundary normalization of a user-authored area name: surrounding whitespace
 * only. Nothing inside the name is rewritten, so what the owner typed is what
 * the selector shows.
 */
export const normalizeHomeAreaName = (raw: string): string => raw.trim();

/**
 * Comparison key for an area name: trimmed, Unicode-composed (NFC), lowercased.
 * NFC before comparing because a composed "Café" and a decomposed "Café"
 * render identically, so folding raw code points would let two visually
 * identical names pass both the duplicate and the reserved check. Folding is
 * comparison-only: the stored name keeps the exact form the owner typed.
 */
export const foldHomeAreaName = (raw: string): string => (
  normalizeHomeAreaName(raw).normalize('NFC').toLowerCase()
);

/**
 * How many characters a name spends against the cap, as the refusal message
 * ("40 characters or fewer") means it: NFC-composed first, then counted in code
 * points.
 *
 * NFC first because the cap must agree with `foldHomeAreaName` about what one
 * name is. Without it, a composed "é" costs one and its canonically equivalent
 * decomposed spelling costs two, so two names the duplicate check calls
 * IDENTICAL would get different limits. Composition only, never the lowercasing
 * — that is comparison-only and can itself change length (Turkish 'İ').
 *
 * Code points, not UTF-16 units: an astral symbol (emoji) is one character to
 * the owner but two units to `String.length`, and counting units would refuse a
 * name the message calls legal.
 */
const countHomeAreaNameCharacters = (name: string): number => [...name.normalize('NFC')].length;

/**
 * The first rule the name being written breaks, or `null` when it is savable.
 *
 * Scoped to the ONE entry under edit, deliberately, and not to the whole
 * composed list: a list-level statement would refuse an unrelated area's edit
 * because of a name the owner cannot see, with copy pointing at the wrong
 * field. Uniqueness is inherently a pair property, so it alone looks outward,
 * at `otherNames`. This mirrors `validateSubHomeDraft`'s `validateDraftName`,
 * which is what the editor shows inline.
 */
export const findHomeAreaNameRejection = (params: {
  /** The name being written, before normalization. */
  name: string;
  /** The other areas' names in the resulting config. */
  otherNames: readonly string[];
}): HomeAreaNameRejection | null => {
  const name = normalizeHomeAreaName(params.name);
  if (name.length === 0) return { reason: 'name_required' };
  if (countHomeAreaNameCharacters(name) > HOME_AREA_NAME_MAX_LENGTH) {
    return { reason: 'name_too_long', maxLength: HOME_AREA_NAME_MAX_LENGTH };
  }
  const folded = foldHomeAreaName(name);
  const reserved = RESERVED_HOME_AREA_NAMES
    .find((entry) => foldHomeAreaName(entry) === folded);
  if (reserved !== undefined) return { reason: 'name_reserved', reservedName: reserved };
  const clash = params.otherNames.find((other) => foldHomeAreaName(other) === folded);
  return clash === undefined
    ? null
    : { reason: 'name_duplicate', otherName: normalizeHomeAreaName(clash) };
};
