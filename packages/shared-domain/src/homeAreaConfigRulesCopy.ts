/**
 * What to do next when the runtime refuses a "Multiple meters" save.
 *
 * Companion to `homeAreaConfigRules.ts` and part of the same vocabulary as
 * `homesManagementCopy.ts` (meter area / Main home / Whole-home meter, see
 * `notes/ui-terminology.md`). Sentences shared with `composeDraftErrorLine`
 * are reused from there rather than respelled, so the editor's inline error
 * and the save toast never say the same thing two ways.
 */

import type { SettingsUiHomesSaveRefusal } from '../../contracts/src/settingsUiHomes';
import {
  composeDraftErrorLine,
  HOMES_CONFIG_DEGRADED,
  HOMES_SAVE_FAILED_TOAST,
} from './homesManagementCopy';

/**
 * Shown when an area save is refused because the Main home has no whole-home
 * meter persisted. Carries its own reason clause: the refusal fires from the
 * EDITOR, where `HOMES_MAIN_METER_NOTICE` is not rendered (it belongs to the
 * list, and on a first area the area count is still zero), so a bare remedy
 * would arrive with no reason. Names the control as a setting, not as an
 * option in the picker — same shape as `HOMES_MAIN_METER_NOTICE`.
 */
export const HOMES_AREA_NEEDS_MAIN_METER = 'Meter areas need the Main home’s own meter so '
  + 'PELS can tell the homes apart. Set “Whole-home meter” under Limits & safety, then save '
  + 'this area.';

/**
 * An area save refused because the power source is Flow: a Flow reading
 * carries no meter identity, so the area would never be limited. Reason
 * first, then the control named as a setting to change, same shape as
 * `HOMES_AREA_NEEDS_MAIN_METER`. Fires from the editor, where
 * `HOMES_FLOW_SOURCE_NOTICE` has already explained the why in full.
 */
export const HOMES_AREA_NEEDS_HOMEY_ENERGY = 'Meter areas need the “Power meter” power source, '
  + 'or PELS can’t tell which meter a reading belongs to. Set “Power source” under '
  + 'Limits & safety, then save this area.';

/**
 * The same exclusion from the other side: switching the power source to Flow
 * while meter areas are running. Deleting an area works on any source, so
 * the remedy this names is never itself blocked.
 */
export const HOMES_POWER_SOURCE_NEEDED_BY_AREAS = 'While meter areas exist, PELS needs the '
  + '“Power meter” power source. Remove your meter areas under Multiple meters first.';

/**
 * The Whole-home meter field's resting hint. Same shape as the area picker's
 * `HOMES_METER_HINT` ("The device that measures this area's power use.").
 * Mirrored statically in `index.html`; this constant is the render-time truth
 * the hint element is restored to after the empty-list variant below.
 */
export const WHOLE_HOME_METER_HINT = 'The meter that measures your whole home’s power use.';

/**
 * The hint when the live report lists no meters at all: the picker has
 * nothing to offer, so pointing at it ("pick a meter") would name an
 * impossible action. Names the actual remedy instead. The empty list is
 * never cached, so this self-heals on the next panel open.
 */
export const WHOLE_HOME_METER_NONE_FOUND_HINT = 'PELS found no electricity meters in Homey '
  + 'Energy. Add your home’s meter to Homey first, then pick it here.';

/**
 * Switching the power source to "Power meter" needs the meter in the same
 * save (the seam persists them atomically), so with no meter chosen yet the
 * switch stays a draft until the picker below is answered.
 */
export const POWER_SOURCE_PICK_METER_PROMPT = 'Pick a whole-home meter to finish switching '
  + 'to “Power meter”.';

/**
 * Toast pair for the whole-home meter save — the parallel of the
 * power-source pair below, and registered here for the same reason: runtime
 * logs and support read the same words the user saw.
 */
export const WHOLE_HOME_METER_SAVED = 'Whole-home meter saved.';
export const WHOLE_HOME_METER_SAVE_FAILED = 'Failed to save whole-home meter.';

/**
 * Whole-home meter picker option labels. The placeholder doubles as the
 * loaded-empty state's label; the orphan label deliberately carries the
 * consequence ("not found in Homey"), never the raw device id.
 */
export const WHOLE_HOME_METER_PLACEHOLDER_OPTION = 'Choose a meter';
export const WHOLE_HOME_METER_NONE_FOUND_OPTION = 'No meters found';
export const WHOLE_HOME_METER_ORPHAN_OPTION = 'Previously selected meter (not found in Homey)';
export const WHOLE_HOME_METER_LOADING_OPTION = 'Selected meter (loading…)';

/** Power-source save refused while the meter-area config cannot be read safely. */
export const HOMES_POWER_SOURCE_SAVE_DEGRADED = 'PELS can’t safely change the power source '
  + 'right now. Your meter-area settings couldn’t be read. Try again in a few minutes.';

/** Generic power-source save failure, also the toast fallback for thrown errors. */
export const HOMES_POWER_SOURCE_SAVE_FAILED = 'Failed to save power source.';

/**
 * One actionable line per refusal of an area create/edit/delete. `invalid` is
 * the only one that keeps the generic save-failed line: it covers malformed
 * payloads and the zone-overlap combinations the editor already blocks inline,
 * so there is no single next step to name.
 */
export const composeHomeAreaSaveRefusalLine = (refusal: SettingsUiHomesSaveRefusal): string => {
  if (refusal.reason === 'degraded') return HOMES_CONFIG_DEGRADED;
  if (refusal.reason === 'main_meter_required') return HOMES_AREA_NEEDS_MAIN_METER;
  if (refusal.reason === 'homey_energy_required') return HOMES_AREA_NEEDS_HOMEY_ENERGY;
  if (refusal.reason === 'area_limit_reached') {
    // Reachable on an edit too (a config already past the cap), so the remedy
    // must not assume the user was adding.
    return `PELS handles up to ${refusal.maxCount} meter areas. Remove one to make room.`;
  }
  if (refusal.reason === 'meter_in_use') {
    return composeDraftErrorLine({ kind: 'meter_in_use', otherName: refusal.otherName });
  }
  if (refusal.reason === 'name_required') return composeDraftErrorLine({ kind: 'name_missing' });
  if (refusal.reason === 'name_duplicate') {
    return composeDraftErrorLine({ kind: 'name_duplicate', otherName: refusal.otherName });
  }
  if (refusal.reason === 'name_reserved') {
    return `“${refusal.reservedName}” is what PELS calls the rest of your home. `
      + 'Give this area a different name.';
  }
  if (refusal.reason === 'name_too_long') {
    return `Shorten the name to ${refusal.maxLength} characters or fewer.`;
  }
  return HOMES_SAVE_FAILED_TOAST;
};

/**
 * One actionable line per refusal of a power-source change. Typed over the
 * full refusal union like `composeHomeAreaSaveRefusalLine`, so a reason this
 * op cannot produce falls back to the generic line instead of rendering an
 * area instruction over the power-source control.
 */
export const composePowerSourceSaveRefusalLine = (refusal: SettingsUiHomesSaveRefusal): string => {
  if (refusal.reason === 'degraded') return HOMES_POWER_SOURCE_SAVE_DEGRADED;
  if (refusal.reason === 'homey_energy_required') return HOMES_POWER_SOURCE_NEEDED_BY_AREAS;
  // The Homey Energy switch carries the meter it will read, so it can lose to
  // an area that already owns that meter — same line the picker shows.
  if (refusal.reason === 'meter_in_use') {
    return composeDraftErrorLine({ kind: 'meter_in_use', otherName: refusal.otherName });
  }
  return HOMES_POWER_SOURCE_SAVE_FAILED;
};
