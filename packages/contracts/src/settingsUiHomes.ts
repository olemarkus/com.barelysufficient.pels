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
};
