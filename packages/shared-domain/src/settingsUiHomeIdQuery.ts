/**
 * Query parameter naming ONE sub-home on `ui_plan` / `ui_power` / `ui_devices`
 * (multi-home). Absent = the historical whole-home / main-home read, whose URI
 * and payload stay byte-identical: `?homeId=main` is never produced, and the
 * runtime boundary REFUSES it if a client sends it anyway.
 *
 * The settings UI writes it (`packages/settings-ui/src/ui/homey.ts`) and the
 * runtime boundary parser reads it (`setup/settingsUiHomeScope.ts`), so its one
 * copy lives here rather than in `packages/contracts`, which the packaged app
 * does not ship.
 */
export const SETTINGS_UI_HOME_ID_QUERY_PARAM = 'homeId';
