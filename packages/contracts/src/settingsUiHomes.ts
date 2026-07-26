/**
 * Typed payload for the read-only `ui_homes` settings-UI endpoint (multi-home).
 *
 * Structural mirror of the runtime's `lib/home` domain shapes (`SubHomeConfig`,
 * `HomeMembership`, `ZoneTree`): contracts cannot import runtime modules, so
 * the composing handler (`setup/settingsUiApi.ts`) type-checks the mirror
 * against the domain values it serves. `ui_homes` itself is read-only. The
 * settings UI sends area and Main-meter mutations through the guarded
 * `ui_homes_save` intent endpoint below; it never writes either ownership
 * store directly.
 */

export const SETTINGS_UI_HOMES_PATH = '/ui_homes';
export const SETTINGS_UI_HOMES_SAVE_PATH = '/ui_homes_save';

/**
 * Intent operation for the `ui_homes_save` endpoint. INTENT, not state: the
 * client names the one area or Main-meter selection it touches and the runtime
 * applies it against the FRESHLY read persisted config (classified reader,
 * refuse-on-suspect, marker-first classified area write). Keeping both meter
 * ownership mutations behind one serialized server seam prevents Main and a
 * meter area from claiming the same explicit meter in either write order.
 */
export type SettingsUiHomesSaveRequest =
  | {
    op: 'upsert';
    area: {
      /** Absent on create — the runtime allocates the id. */
      homeId?: string;
      name: string;
      rootZoneId: string;
      meterDeviceId: string | null;
    };
  }
  | { op: 'delete'; homeId: string }
  | {
    op: 'set_main_meter';
    /** `null` selects Automatic; a string selects Main's explicit meter. */
    meterDeviceId: string | null;
  };

/**
 * Typed refusal contract. Each variant carries what the UI needs to say what
 * to do next, so no refusal has to fall back to "something went wrong":
 * - `degraded` — the persisted config could not be read safely (suspect store
 *   read); the UI shows its degraded copy.
 * - `invalid` — malformed op / implausible resulting config / a root zone that
 *   would swallow the whole home.
 * - `meter_in_use` — identifies the meter area that already owns a requested
 *   Main-home meter.
 * - `main_meter_required` — a meter area cannot exist while the Main home
 *   still reads the combined total of every meter, so the Main home must name
 *   its own whole-home meter (both directions: saving an area, and selecting
 *   Automatic while areas exist).
 * - `meter_unnameable` — the same requirement on a home where it can never be
 *   satisfied: the whole-home reading comes from an id-less aggregate (the
 *   report's only cumulative item carries no device id), so no whole-home
 *   meter can be selected and meter areas are not supported yet. Honest-state
 *   refusal — chosen only from the producer's latched arrangement, never from
 *   a transient read miss.
 * - `area_limit_reached` / `name_*` — the area being saved breaks a config rule
 *   from `packages/shared-domain/src/homeAreaConfigRules.ts`. The names are
 *   load-bearing (home selector labels, `capacity_shortfall` Flow token), so
 *   they are enforced here, not only in the editor's draft validation.
 */
export type SettingsUiHomesSaveResponse =
  | { ok: true }
  | { ok: false; reason: 'degraded' | 'invalid' | 'main_meter_required' | 'meter_unnameable' }
  | { ok: false; reason: 'meter_in_use'; otherName: string }
  | { ok: false; reason: 'area_limit_reached'; maxCount: number }
  | { ok: false; reason: 'name_required' }
  | { ok: false; reason: 'name_too_long'; maxLength: number }
  | { ok: false; reason: 'name_reserved'; reservedName: string }
  | { ok: false; reason: 'name_duplicate'; otherName: string };

/**
 * The refusal half of {@link SettingsUiHomesSaveResponse}. Declared once here
 * so the runtime seam that produces a refusal and the shared-domain helper
 * that renders it cannot drift into two spellings of the same `Extract<>`.
 */
export type SettingsUiHomesSaveRefusal = Extract<SettingsUiHomesSaveResponse, { ok: false }>;

/**
 * How a device's membership was decided. DIAGNOSTICS AND DISPLAY ONLY — the
 * UI may badge a fallback, but no consumer may branch control behaviour on it
 * (resolution-in-producer rule; see `lib/home/membership.ts`).
 */
type SettingsUiHomeMembershipSource = 'zone' | 'pin' | 'fallback';

type SettingsUiHomeMembership = {
  homeId: string;
  source: SettingsUiHomeMembershipSource;
};

/** One configured sub-home (the main home is implicit and never listed). */
type SettingsUiSubHome = {
  homeId: string;
  name: string;
  rootZoneId: string;
  meterDeviceId: string | null;
};

type SettingsUiZoneNode = {
  id: string;
  name: string;
  /** Parent zone id; `null` for the root zone. */
  parent: string | null;
};

export type SettingsUiHomesPayload = {
  /** Normalized sub-home configs from the homes registry. */
  homes: SettingsUiSubHome[];
  /** Resolved membership per snapshot device, with the resolver's source. */
  membershipByDeviceId: Record<string, SettingsUiHomeMembership>;
  /** The transport's cached zone tree; `null` until the first successful fetch. */
  zoneTree: Record<string, SettingsUiZoneNode> | null;
  hasSubHomes: boolean;
  /**
   * Producer-resolved activation posture. False means a saved pre-GA config is
   * intentionally held in Main home until the owner saves a meter area.
   */
  runtimeActive: boolean;
  /**
   * True while the runtime cannot vouch for the served config: either homes
   * store read classified suspect (persisted truth unknown; `homes` may be a
   * stale cache) or the membership service is not wired yet (boot window).
   * The settings UI must refuse config mutations while set — a whole-value
   * `homes_config` write composed from a stale/empty view could erase
   * persisted areas.
   */
  configDegraded: boolean;
};
