/**
 * User-facing copy for the "Multiple meters" settings surface.
 *
 * Vocabulary (notes/ui-terminology.md): each configured entry is a **meter
 * area** — a part of your home with its own meter; the complement is the
 * **Main home**. The internal words (`sub-home`, `homeId`, `membership`)
 * never surface. Copy says what happens, stays short and factual.
 *
 * Lives in shared-domain so the settings UI and any future runtime logging
 * speak the same words for the same state (`feedback_ui_text_shared_with_logs`).
 * Import this module directly — there is no shared-domain barrel.
 */

import type { SubHomeDraftError, SubHomeDraftWarning } from './homesManagement';

// The hub nav card + panel title strings ("Multiple meters" / "Parts of your
// home with their own meter") live in the static `public/index.html` markup,
// like every other settings sub-page's chrome — they are not re-exported here.

// ── Progressive disclosure: empty state ────────────────────────────────────

/** Shown alone (with the Add button) until the first meter area exists. */
export const HOMES_EMPTY_EXPLAINER = 'If a part of your home has its own electricity meter — '
  + 'a rental unit, an annex, a cabin — PELS can count its devices against that meter instead '
  + 'of the Main home.';
export const HOMES_ADD_BUTTON = 'Add meter area';

// ── List ───────────────────────────────────────────────────────────────────

/** Muted footnote below the list card — names the complement without jargon. */
export const HOMES_MAIN_HOME_NOTE = 'Devices outside these areas belong to the Main home.';
export const HOMES_EDIT_BUTTON = 'Edit';
export const HOMES_DELETE_BUTTON = 'Remove';

/** A configured meter device that no longer exists in Homey. */
export const HOMES_METER_NOT_FOUND = 'Meter not found';
/** A configured root zone that no longer exists in Homey. */
export const HOMES_ZONE_NOT_FOUND = 'Zone not found';

export const formatHomeDeviceCount = (count: number): string => (
  count === 1 ? '1 device' : `${count} devices`
);

/** List-row supporting line: `⟨meter⟩ · ⟨zone⟩ · N devices`. */
export const composeSubHomeSupportingLine = (params: {
  meterName: string | null;
  zoneName: string | null;
  deviceCount: number;
}): string => [
  params.meterName ?? HOMES_METER_NOT_FOUND,
  params.zoneName ?? HOMES_ZONE_NOT_FOUND,
  formatHomeDeviceCount(params.deviceCount),
].join(' · ');

// ── Delete confirm ─────────────────────────────────────────────────────────

/** The confirm step names the consequence: devices re-home to the Main home. */
export const composeDeleteConfirmBody = (name: string): string => (
  `Remove “${name}”? Its devices move back to the Main home.`
);
export const HOMES_DELETE_CONFIRM_BUTTON = 'Remove';
export const HOMES_DELETE_CANCEL_BUTTON = 'Cancel';

// ── Editor (create + edit share one form) ──────────────────────────────────

export const HOMES_EDITOR_TITLE_NEW = 'New meter area';
export const HOMES_EDITOR_TITLE_EDIT = 'Edit meter area';

export const HOMES_METER_LABEL = 'Meter';
export const HOMES_METER_PLACEHOLDER = 'Choose a meter';
export const HOMES_METER_HINT = 'The device that measures this area’s power use.';
/** Shown when no Homey device reports power at all. */
export const HOMES_NO_METER_DEVICES = 'PELS found no power-reporting devices in Homey. '
  + 'Add this area’s meter to Homey first, then pick it here.';

/** A previously-selected meter no longer in Homey (kept selectable so the setting isn't lost). */
export const HOMES_METER_MISSING_OPTION = 'Previously selected meter (not found in Homey)';
/** The configured meter shown before the device list has loaded (neutral, not "deleted"). */
export const HOMES_METER_LOADING_OPTION = 'Selected meter (loading…)';

export const HOMES_ZONE_LABEL = 'Zone';
export const HOMES_ZONE_PLACEHOLDER = 'Choose a zone';
export const HOMES_ZONE_HINT = 'Devices in this zone and its sub-zones count as part of this meter area.';

/**
 * Live membership preview under the Zone field — makes the sweep consequence
 * checkable before saving (the suggestion can legitimately pick a wide
 * ancestor). Counts the devices PELS knows about; `approximate` marks the
 * fresh-boot fallback (zone-containment estimate before any resolved
 * membership exists) with an honest "About".
 */
export const formatZoneDeviceCount = (count: number, approximate = false): string => {
  if (count === 0) return 'No devices in this zone and its sub-zones';
  const base = count === 1
    ? '1 device in this zone and its sub-zones'
    : `${count} devices in this zone and its sub-zones`;
  return approximate ? `About ${base}` : base;
};

export const HOMES_NAME_LABEL = 'Name';

export const HOMES_SAVE_BUTTON = 'Save';
/** Save-button label while the edited area vanished from the fresh list. */
export const HOMES_SAVE_AGAIN_BUTTON = 'Add again';
export const HOMES_CANCEL_BUTTON = 'Cancel';

/**
 * Editor reconciliation line: a refetch found the edited area gone (removed
 * from another device/session). Saving honestly re-adds it — never a fake
 * "saved" over a vanished entry.
 */
export const HOMES_EDITOR_AREA_GONE = 'This meter area was removed while you were editing. '
  + 'Saving adds it again.';

/** `⟨device⟩ · ⟨zone⟩` when the meter's zone is known, else the bare name. */
export const composeMeterOptionLabel = (name: string, zoneName: string | null): string => (
  zoneName === null ? name : `${name} · ${zoneName}`
);

/** Two-space indent per depth level keeps the zone hierarchy readable in a native select. */
export const composeZonePickerOptionLabel = (name: string, depth: number): string => (
  `${'  '.repeat(depth)}${name}`
);

// ── Validation lines ───────────────────────────────────────────────────────

export const composeDraftErrorLine = (error: SubHomeDraftError): string => {
  if (error.kind === 'name_missing') return 'Give this meter area a name.';
  if (error.kind === 'name_duplicate') return `Another meter area is already named “${error.otherName}”.`;
  if (error.kind === 'meter_missing') return 'Pick the meter for this area.';
  if (error.kind === 'meter_in_use') return `“${error.otherName}” already uses this meter.`;
  if (error.kind === 'zone_missing') return 'Pick the zone this meter covers.';
  if (error.kind === 'zone_is_root') {
    return 'This zone covers the whole home. Pick just the part this meter measures.';
  }
  return `This zone overlaps “${error.otherName}”. Pick a zone outside it.`;
};

const DRAFT_WARNING_LINES: Record<SubHomeDraftWarning['kind'], string> = {
  meter_outside_zone:
    'This meter sits outside the chosen zone. You can still save — but check that the zone is right.',
};

export const composeDraftWarningLine = (warning: SubHomeDraftWarning): string => (
  DRAFT_WARNING_LINES[warning.kind]
);

// ── Degraded config (mutations refused) ────────────────────────────────────

/**
 * Shown while `ui_homes` reports `configDegraded` — the runtime could not
 * read the persisted config, so every mutation control is disabled (a save
 * composed from a stale view could erase areas).
 */
export const HOMES_CONFIG_DEGRADED = 'PELS can’t safely change meter areas right now — '
  + 'your settings couldn’t be read. Try again in a few minutes.';

// ── Main home meter notice ─────────────────────────────────────────────────

/**
 * Shown while meter areas exist on the Homey Energy source without an
 * explicit whole-home meter. Consequence-first: what is happening right now,
 * then the remedy naming the real control ("Whole-home meter", Limits &
 * safety).
 */
export const HOMES_MAIN_METER_NOTICE = 'Right now PELS reads the combined total of all meters, '
  + 'so Main home devices get limited to make room for the meter areas’ usage. Pick the Main '
  + 'home’s own meter — “Whole-home meter”, under Limits & safety.';
export const HOMES_MAIN_METER_NOTICE_LINK = 'Open Limits & safety';
export const HOMES_MAIN_METER_SAVE_DEGRADED = 'PELS can’t safely change the Whole-home meter '
  + 'right now — your meter-area settings couldn’t be read. Try again in a few minutes.';

// ── Flow power-source notice ───────────────────────────────────────────────

/**
 * Shown while the power source is Flow (not Homey Energy). Meter areas read each
 * meter's own live power from the Homey Energy report; a Flow power reading
 * carries no meter identity, so an area configured under Flow receives no
 * samples and is never limited. Consequence-first, names the requirement.
 */
export const HOMES_FLOW_SOURCE_NOTICE = 'Meter areas need the Homey Energy power source. On the '
  + 'Flow power source PELS can’t tell which meter a reading belongs to, so an area you add here '
  + 'won’t be limited.';

// ── Load / save states ─────────────────────────────────────────────────────

export const HOMES_LOAD_FAILED = 'Couldn’t load your meter areas. '
  + 'PELS will try again the next time you open this page.';
/** The zone tree hasn't been fetched yet — adding needs zones to pick from. */
export const HOMES_ZONES_UNAVAILABLE = 'Homey’s zones aren’t available right now — try again in a moment.';
export const HOMES_SAVED_TOAST = 'Meter area saved.';
export const HOMES_REMOVED_TOAST = 'Meter area removed.';
export const HOMES_SAVE_FAILED_TOAST = 'Couldn’t save changes — try again.';
