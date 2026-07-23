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
 * Typed refusal contract: `degraded` = the persisted config could not be
 * read safely (suspect store read — the UI shows its degraded copy);
 * `invalid` = malformed op / implausible resulting config / a root zone that
 * would swallow the whole home; `meter_in_use` identifies the meter area that
 * already owns a requested Main-home meter so the UI can explain the refusal.
 */
export type SettingsUiHomesSaveResponse =
  | { ok: true }
  | { ok: false; reason: 'degraded' | 'invalid' }
  | { ok: false; reason: 'meter_in_use'; otherName: string };

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
