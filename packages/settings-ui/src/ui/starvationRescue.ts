import {
  SETTINGS_UI_STARVATION_RESCUE_CREATE_PATH,
  SETTINGS_UI_STARVATION_RESCUE_PREVIEW_PATH,
} from '../../../contracts/src/settingsUiApi.ts';
import type {
  SettingsUiStarvationRescueCreateResponse,
  SettingsUiStarvationRescuePreviewResponse,
} from '../../../contracts/src/starvationRescue.ts';
import {
  resolveStarvationRescueRejectCopy,
  STARVATION_RESCUE_WIDGET_COPY,
} from '../../../shared-domain/src/planStarvation.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { showToast } from './toast.ts';
import { refreshPlanSurface } from './planSurfaceRefresh.ts';

// Controller for the overview device-card budget-exempt rescue (the bounded
// "Let it run now" path — identical to the starvation_rescue widget's rescue,
// surfaced from the device card). The Preact chip stays thin: it calls these and
// renders the returned state. Kept out of the view layer so the view has no
// network/fetch logic (views/AGENTS.md).

// The device IDs the rescue chip may offer the action on: the same gate the
// widget uses (task-free + a known target), resolved server-side and carried on
// the Main plan (`rescuableDeviceIds`), so every plan the Overview renders
// brings its own gate and an older plan can never pair with a newer gate.
let rescuableDeviceIds: ReadonlySet<string> = new Set();
// Devices this WebView just created a rescue for. A plan built before the create
// landed still lists them, so they stay hidden until a plan stops listing them.
const rescuedDeviceIds = new Set<string>();

export const applyPlanRescueGate = (deviceIds: readonly string[]): void => {
  rescuableDeviceIds = new Set(deviceIds);
  rescuedDeviceIds.forEach((deviceId) => {
    if (!rescuableDeviceIds.has(deviceId)) rescuedDeviceIds.delete(deviceId);
  });
};

export const isStarvationRescuable = (deviceId: string): boolean => (
  rescuableDeviceIds.has(deviceId) && !rescuedDeviceIds.has(deviceId)
);

// The preview resolves the bounded window AND the gated permission set the card
// must disclose before the user can confirm, so a rejection is no longer a
// silent best-effort miss — the chip drops back to idle, and the user needs to
// know why. Toasting here rather than in the view keeps the network/toast seam
// in the controller (`views/AGENTS.md`); the copy comes from the SHARED rescue
// resolver so this surface can't drift from the rescue widget.
export const previewStarvationRescue = async (
  deviceId: string,
): Promise<SettingsUiStarvationRescuePreviewResponse> => {
  try {
    const response = await callApi<SettingsUiStarvationRescuePreviewResponse>(
      'POST',
      SETTINGS_UI_STARVATION_RESCUE_PREVIEW_PATH,
      { deviceId },
    );
    if (!response.ok) {
      const reason = 'reason' in response ? response.reason : undefined;
      await showToast(resolveStarvationRescueRejectCopy(reason), 'warn');
    }
    return response;
  } catch (error) {
    await logSettingsError('Failed to preview budget-exempt rescue', error, 'previewStarvationRescue');
    await showToast(STARVATION_RESCUE_WIDGET_COPY.rescueError, 'warn');
    throw error;
  }
};

export type StarvationRescueOutcome =
  | { ok: true; runsCurrentHour: boolean }
  | { ok: false };

// Commit the rescue. `deadlineAtMs` echoes the previewed deadline when a preview
// ran (so a confirm left open across an hour boundary persists what the user
// saw); omitted for a plain confirm with no preview. On success the plan surface
// is bumped and the rescuable set is invalidated so the just-rescued device drops
// its chip on the next refresh. Surfaces a toast either way; returns the outcome
// so the chip can render the honest success flash.
export const createStarvationRescue = async (
  deviceId: string,
  deadlineAtMs?: number,
): Promise<StarvationRescueOutcome> => {
  try {
    const body = deadlineAtMs === undefined ? { deviceId } : { deviceId, deadlineAtMs };
    const response = await callApi<SettingsUiStarvationRescueCreateResponse>(
      'POST',
      SETTINGS_UI_STARVATION_RESCUE_CREATE_PATH,
      body,
    );
    if (!response.ok) {
      // Read the reason via `in` rather than discriminant narrowing — the
      // settings-UI tsconfig runs non-strict, where literal-discriminant union
      // narrowing on `!response.ok` does not reliably split the union.
      // Copy comes from the SHARED rescue resolver (deadline-passed retry line,
      // the non-retryable separate-meter line for `device_in_sub_home`, generic
      // otherwise) so this surface can never drift from the rescue widget.
      const reason = 'reason' in response ? response.reason : undefined;
      await showToast(resolveStarvationRescueRejectCopy(reason), 'warn');
      return { ok: false };
    }
    // The device is now task-having → no longer rescuable. Hide its chip now;
    // the next plan carries the server's gate.
    rescuedDeviceIds.add(deviceId);
    refreshPlanSurface();
    await showToast(
      response.runsCurrentHour
        ? STARVATION_RESCUE_WIDGET_COPY.rescueDone
        : STARVATION_RESCUE_WIDGET_COPY.rescueDoneQueued,
      'ok',
    );
    return { ok: true, runsCurrentHour: response.runsCurrentHour };
  } catch (error) {
    await logSettingsError('Failed to create budget-exempt rescue', error, 'createStarvationRescue');
    await showToast(STARVATION_RESCUE_WIDGET_COPY.rescueError, 'warn');
    return { ok: false };
  }
};
