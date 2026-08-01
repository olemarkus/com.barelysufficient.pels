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

import { resolveHomeAreaDisplayName } from './homeNames';
import type { SubHomeDraftError, SubHomeDraftWarning } from './homesManagement';

// The hub nav card + panel title strings ("Multiple meters" / "Parts of your
// home with their own meter") live in the static `public/index.html` markup,
// like every other settings sub-page's chrome — they are not re-exported here.

// ── Beta notice ────────────────────────────────────────────────────────────

/**
 * Leads the Multiple meters page while the feature is newly released (locked
 * decision: confident, names the coverage gap, invites reports — no hedging
 * about whether it works).
 */
export const HOMES_BETA_NOTICE = 'Meter areas are new. They work as intended, but some PELS '
  + 'features don’t cover them yet. Report anything unexpected and it gets fixed fast.';

// ── Progressive disclosure: empty state ────────────────────────────────────

/** Shown alone (with the Add button) until the first meter area exists. */
export const HOMES_EMPTY_EXPLAINER = 'If a part of your home has its own electricity meter — '
  + 'a rental unit, an annex, a cabin — PELS can count its devices against that meter instead '
  + 'of the Main home.';
export const HOMES_ADD_BUTTON = 'Add meter area';

// The home names themselves (`HOMES_MAIN_HOME_NAME`, `HOMES_UNNAMED_AREA_NAME`,
// `resolveHomeAreaDisplayName`) live in the dependency-neutral `homeNames.ts`
// leaf: `homesManagement.ts` needs them too, and it is what this module imports
// its error/warning types FROM — keeping them here made the pair circular.

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

// ── Home badges (Devices + Modes lists) ────────────────────────────────────

/**
 * The label a device row carries once meter areas are in use: the owner's own
 * name for the area, or this constant for the implicit complement. Same word
 * the Limits switcher's Main option uses (`homeLimitsCopy.ts`) so the implicit
 * home reads identically on every surface.
 */
export const HOMES_BADGE_MAIN_HOME = 'Main home';

/** The badge's own text: the area name as authored, else the Main-home word. */
export const composeHomeBadgeLabel = (areaName: string | null): string => (
  areaName ?? HOMES_BADGE_MAIN_HOME
);

/**
 * Badge tooltip. Says what the badge means for the bill (which meter this
 * device's usage counts against) and doubles as the full-name reveal when a
 * long user-authored area name is truncated in the chip.
 */
export const composeHomeBadgeTooltip = (areaName: string | null): string => (
  areaName === null
    ? 'This device belongs to the Main home.'
    : `This device belongs to “${areaName}” and counts against that meter.`
);

// ── Delete confirm ─────────────────────────────────────────────────────────

/** The confirm step names the consequence: devices re-home to the Main home. */
// Self-resolving (as are the other composers that quote an area name below):
// callers pass the raw persisted name, and the blank-name rule is applied here
// so no display consumer can forget it. `Remove “”?` names nothing.
export const composeDeleteConfirmBody = (name: string): string => (
  `Remove “${resolveHomeAreaDisplayName(name)}”? Its devices move back to the Main home.`
);
export const HOMES_DELETE_CONFIRM_BUTTON = 'Remove';
export const HOMES_DELETE_CANCEL_BUTTON = 'Cancel';

// ── Editor (create + edit share one form) ──────────────────────────────────

export const HOMES_EDITOR_TITLE_NEW = 'New meter area';
export const HOMES_EDITOR_TITLE_EDIT = 'Edit meter area';

export const HOMES_METER_LABEL = 'Meter';
export const HOMES_METER_PLACEHOLDER = 'Choose a meter';
export const HOMES_METER_HINT = 'The device that measures this area’s power use.';
/**
 * Shown when the picker's option list is empty. The list is NOT "everything that
 * reports power": it offers whole-home (cumulative) meters from the Homey Energy
 * report plus sensor-class devices, so a house full of metering plugs and
 * chargers still lands here. Claiming Homey has no power-reporting devices is
 * false for that owner and sends them hunting; name what is actually missing.
 */
export const HOMES_NO_METER_DEVICES = 'PELS found no electricity meters in Homey Energy. '
  + 'A metering plug or appliance doesn’t count — add this area’s own meter to Homey '
  + 'first, then pick it here.';

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
  if (error.kind === 'name_duplicate') {
    // `otherName` is another area's raw persisted name, so the blank case is
    // resolved here like every other quoted area name. (A duplicate of a blank
    // name cannot actually fire — `name_missing` wins first — but the rule is
    // applied uniformly rather than reasoned away per branch.)
    return `Another meter area is already named “${resolveHomeAreaDisplayName(error.otherName)}”.`;
  }
  if (error.kind === 'meter_missing') return 'Pick the meter for this area.';
  if (error.kind === 'meter_in_use') {
    // `otherName` here can also be the Main home's literal label, which the
    // resolver passes through unchanged.
    return `“${resolveHomeAreaDisplayName(error.otherName)}” already uses this meter.`;
  }
  if (error.kind === 'zone_missing') return 'Pick the zone this meter covers.';
  if (error.kind === 'zone_is_root') {
    return 'This zone covers the whole home. Pick just the part this meter measures.';
  }
  return `This zone overlaps “${resolveHomeAreaDisplayName(error.otherName)}”. Pick a zone outside it.`;
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
 *
 * BOTH consequences are named because PELS genuinely cannot tell which one it
 * is in. If the reading merely INCLUDES an area, Main home devices get limited
 * for usage that is not theirs. If the reading IS an area's own meter, that is
 * a proven ownership collision and PELS stops changing Main home devices
 * altogether (`HomeMembershipService.isMainHomeActuationFenced`) — the more
 * serious case, because nothing is then holding the Main home under its hard
 * cap. The remedy is identical either way, and the hard cap is a physical
 * tariff step, so it is never offered as something to change.
 */
export const HOMES_MAIN_METER_NOTICE = 'Right now PELS can’t tell which meter it’s reading for '
  + 'the Main home. Main home devices can get limited by usage that belongs to a meter area, and '
  + 'if the meter PELS reads turns out to be a meter area’s own, PELS stops limiting Main home '
  + 'devices at all, so nothing keeps the Main home under its hard cap. '
  + 'Pick the Main home’s own meter — “Whole-home meter”, under Limits & safety.';
export const HOMES_MAIN_METER_NOTICE_LINK = 'Open Limits & safety';

/**
 * Shown while Main's explicitly selected whole-home meter is ALSO a meter
 * area's meter. One meter can't drive two controllers over disjoint device
 * sets, so PELS stops limiting Main-home devices entirely until one of the two
 * selections changes. The stop is silent everywhere else, which is what makes
 * this notice load-bearing: consequence first, then the two controls that
 * resolve it. Only reachable by upgrading a config saved before 2.18, which is
 * why it names the clash rather than blaming the owner's last action.
 */
export const composeHomesMainMeterConflictNotice = (areaName: string): string => (
  `PELS has stopped limiting your Main home: its “Whole-home meter” is also the meter for `
  + `“${resolveHomeAreaDisplayName(areaName)}”. Give one of the two its own meter to start again.`
);
export const HOMES_MAIN_METER_SAVE_DEGRADED = 'PELS can’t safely change the Whole-home meter '
  + 'right now — your meter-area settings couldn’t be read. Try again in a few minutes.';

// ── Flow power-source notice ───────────────────────────────────────────────

/**
 * Shown while the power source is Flow. Meter areas read each meter's own live
 * power from the Homey Energy report; a Flow power reading carries no meter
 * identity, so an area under Flow would receive no samples and never be
 * limited — which is why saving one is refused on this source
 * (`homey_energy_required`, both directions). Consequence-first, and it must
 * name the options the owner will actually see: the picker's two labels are
 * "Flow card" and "Power meter", so an instruction to select "Homey Energy"
 * points at a control that does not exist. Removal stays available as the way
 * out for a config that predates the exclusion.
 */
export const HOMES_FLOW_SOURCE_NOTICE = 'Meter areas need the “Power meter” power source. With '
  + '“Flow card”, PELS can’t tell which meter a reading belongs to, so meter areas can’t be '
  + 'saved here. Set “Power source” under Limits & safety first. Removing an area still works.';

// ── Load / save states ─────────────────────────────────────────────────────

export const HOMES_LOAD_FAILED = 'Couldn’t load your meter areas. '
  + 'PELS will try again the next time you open this page.';
/** The zone tree hasn't been fetched yet — adding needs zones to pick from. */
export const HOMES_ZONES_UNAVAILABLE = 'Homey’s zones aren’t available right now — try again in a moment.';
export const HOMES_SAVED_TOAST = 'Meter area saved.';
export const HOMES_REMOVED_TOAST = 'Meter area removed.';
export const HOMES_SAVE_FAILED_TOAST = 'Couldn’t save changes — try again.';
