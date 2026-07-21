/**
 * Typed payload for the read-only `ui_homes` settings-UI endpoint (multi-home).
 *
 * Structural mirror of the runtime's `lib/home` domain shapes (`SubHomeConfig`,
 * `HomeMembership`, `ZoneTree`): contracts cannot import runtime modules, so
 * the composing handler (`setup/settingsUiApi.ts`) type-checks the mirror
 * against the domain values it serves. READ-ONLY seam: the settings-UI track
 * writes homes/pins via the `homes_config` / `device_home_assignments`
 * settings keys directly, never through this endpoint.
 */

export const SETTINGS_UI_HOMES_PATH = '/ui_homes';
export const SETTINGS_UI_HOMES_SAVE_PATH = '/ui_homes_save';

/**
 * Intent operation for the `ui_homes_save` endpoint. INTENT, not state: the
 * client names the one area it touches and the runtime applies it to the
 * FRESHLY read persisted config (classified reader, refuse-on-suspect,
 * marker-first classified write) — a stale panel can therefore never wipe
 * other areas, and every runtime write protection stays in the path.
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
  | { op: 'delete'; homeId: string };

/**
 * Typed refusal contract: `degraded` = the persisted config could not be
 * read safely (suspect store read — the UI shows its degraded copy);
 * `invalid` = malformed op / implausible resulting config / a root zone that
 * would swallow the whole home; `disabled` = the hidden multi-home feature
 * flag (`multi_home_enabled`) is off, so no meter area may be created or
 * edited — the "Multiple meters" UI is hidden and this write seam refuses even
 * a direct API call.
 */
export type SettingsUiHomesSaveResponse =
  | { ok: true }
  | { ok: false; reason: 'degraded' | 'invalid' | 'disabled' };

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
  /**
   * The hidden multi-home feature flag (`multi_home_enabled`, default false).
   * When false the whole feature is inert — `homes` is empty and the runtime
   * ignores any persisted `homes_config` — and the settings UI hides both the
   * "Multiple meters" section and the per-home Limits switcher. The UI reads
   * this to gate those surfaces rather than inferring the flag from an empty
   * `homes` list (which is also the legitimate zero-areas state when on).
   */
  multiHomeEnabled: boolean;
  /** Normalized sub-home configs from the homes registry. */
  homes: SettingsUiSubHome[];
  /** Resolved membership per snapshot device, with the resolver's source. */
  membershipByDeviceId: Record<string, SettingsUiHomeMembership>;
  /** The transport's cached zone tree; `null` until the first successful fetch. */
  zoneTree: Record<string, SettingsUiZoneNode> | null;
  hasSubHomes: boolean;
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
