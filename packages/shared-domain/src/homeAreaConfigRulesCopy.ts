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
 * Shown when an area save is refused because the Main home is still on
 * Automatic. Carries its own consequence clause: the refusal fires from the
 * EDITOR, where `HOMES_MAIN_METER_NOTICE` is not rendered (it belongs to the
 * list, and on a first area the area count is still zero), so a bare remedy
 * would arrive with no reason. Names the control as a setting, not as an
 * option in the picker — same shape as `HOMES_MAIN_METER_NOTICE`.
 */
export const HOMES_AREA_NEEDS_MAIN_METER = 'Meter areas need the Main home’s own meter, or '
  + 'Main home devices get limited by this area’s usage. Set “Whole-home meter” under '
  + 'Limits & safety, then save this area.';

/**
 * The same rule from the other side: picking Automatic for the Whole-home
 * meter while meter areas exist. Automatic reads the combined total of every
 * meter, so the Main home would be limited by an area's usage. Names the panel
 * the other remedy lives on, which is not the one this renders over.
 */
export const HOMES_MAIN_METER_NEEDED_BY_AREAS = 'While meter areas exist, the Main home needs '
  + 'its own meter. Pick one, or remove your areas under Multiple meters first.';

/**
 * The whole-home-meter requirement on a home where it can never be satisfied:
 * the whole-home reading is an id-less aggregate, so the picker has no meter
 * to offer. Honest-state copy — names the situation, promises nothing.
 */
export const HOMES_METER_UNNAMEABLE = 'Your whole-home meter doesn’t report a device id, and '
  + 'meter areas need one to keep homes apart. Not supported for meter areas yet.';

/**
 * An area save refused because the power source is Flow: a Flow reading
 * carries no meter identity, so the area would never be limited. Reason
 * first, then the control named as a setting to change, same shape as
 * `HOMES_AREA_NEEDS_MAIN_METER`. Fires from the editor, where
 * `HOMES_FLOW_SOURCE_NOTICE` has already explained the why in full.
 */
export const HOMES_AREA_NEEDS_HOMEY_ENERGY = 'Meter areas need the Homey Energy power source, '
  + 'or PELS can’t tell which meter a reading belongs to. Set “Power source” under '
  + 'Limits & safety, then save this area.';

/**
 * The same exclusion from the other side: switching the power source to Flow
 * while meter areas are running. Deleting an area works on any source, so
 * the remedy this names is never itself blocked.
 */
export const HOMES_POWER_SOURCE_NEEDED_BY_AREAS = 'While meter areas exist, PELS needs the '
  + 'Homey Energy power source. Remove your meter areas under Multiple meters first.';

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
  if (refusal.reason === 'meter_unnameable') return HOMES_METER_UNNAMEABLE;
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
  return HOMES_POWER_SOURCE_SAVE_FAILED;
};
