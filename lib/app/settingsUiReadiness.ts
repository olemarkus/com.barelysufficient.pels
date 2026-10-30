// Sentinel prefix the settings UI matches to detect the PELS boot/restart
// window and keep the panel in a bounded loading/retry state instead of
// surfacing a hard error. Duplicated here because the runtime cannot
// value-import deploy-excluded contract source files; the canonical
// declaration lives at `packages/contracts/src/settingsUi/paths.ts`
// (`SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX`). Keep both copies in sync.
const APP_NOT_READY_ERROR_PREFIX = 'PELS_APP_NOT_READY:';

/** The settings UI's boot-window error for a capability the app cannot serve yet. */
export const appNotReadyError = (capability: string): Error => (
  new Error(`${APP_NOT_READY_ERROR_PREFIX} ${capability} unavailable while PELS is starting`)
);
