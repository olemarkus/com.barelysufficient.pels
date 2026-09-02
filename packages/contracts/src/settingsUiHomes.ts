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
    op: 'set_power_source';
    /**
     * Switch whole-home readings to the Flow card. Routed through this seam
     * (not a bare settings write) because `flow` must be refused while meter
     * areas are running, and this seam is where area mutations serialize.
     */
    source: 'flow';
  }
  | {
    op: 'set_power_source';
    /**
     * Homey Energy readings, from this named meter. One op covers both the
     * source switch and a meter change while already on Homey Energy (the
     * seam skips rewriting an unchanged source), so the persisted invariant
     * `power_source = homey_energy ⇒ a meter id is persisted` is established
     * where the keys are written: meter first, then source, and neither a
     * source switch without a meter nor an Automatic selection is
     * expressible. There is no separate set_main_meter op.
     */
    source: 'homey_energy';
    meterDeviceId: string;
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
 * - `main_meter_required` — the Main home has no whole-home meter persisted
 *   (a legacy Automatic install that has not picked one yet, or a degraded
 *   read of it), so an area save cannot prove which meter belongs to Main. One
 *   direction only: the picker can no longer express "no meter", so only the
 *   area save path produces this.
 * - `homey_energy_required` — meter areas and the Flow power source are
 *   mutually exclusive: a Flow reading carries no meter identity, so an area
 *   under Flow gets no samples and is never limited. Refused in both
 *   directions: saving an area while the source is Flow, and switching the
 *   source to Flow while meter areas are running. Deleting an area works on
 *   any source, so the way out is never blocked.
 * - `area_limit_reached` / `name_*` — the area being saved breaks a config rule
 *   from `packages/shared-domain/src/homeAreaConfigRules.ts`. The names are
 *   load-bearing (home selector labels, `capacity_shortfall` Flow token), so
 *   they are enforced here, not only in the editor's draft validation.
 */
export type SettingsUiHomesSaveResponse =
  | { ok: true }
  | {
    ok: false;
    reason: 'degraded' | 'invalid' | 'main_meter_required' | 'homey_energy_required';
  }
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
  /**
   * Name of the meter area that also claims the Main home's explicitly selected
   * whole-home meter, or `null` when there is no such clash. One meter may never
   * own two homes: the same sample would drive two controllers over disjoint
   * device sets, so the runtime fences ALL Main-home actuation while it holds.
   *
   * The fence is re-read live at each write, so fixing either selection clears
   * it without a restart — but nothing else tells the owner their Main home has
   * silently stopped being limited. This field is what the UI needs to say so.
   * Only reachable by upgrade: 2.17 had no cross-store guard, and `ui_homes_save`
   * refuses to create the clash from 2.18 on.
   */
  mainMeterConflictAreaName: string | null;
};
