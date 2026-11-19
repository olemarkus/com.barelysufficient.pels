import type { PendingSteppedLoad } from '../../../../contracts/src/types.ts';
import { resolveManagedState, state, type SettingsUiDeviceView } from '../state.ts';
import { getTargetDevices } from '../devices.ts';
import { refreshFlowConflictFactsExplicit } from '../flowConflictRefresh.ts';
import { ERROR_DURATION_MS, showToast, showToastError } from '../toast.ts';

const setup = document.getElementById('device-detail-stepped-flow-setup');
const status = document.getElementById('device-detail-stepped-flow-status');
const checkButton = document.querySelector<HTMLElement & { disabled: boolean }>('#device-detail-check-stepped-flows');

const UNMANAGED_FLOW_SETUP = 'Turn on “Managed by PELS” to select this device in Homey Flow cards.';

const pendingMessages: Record<PendingSteppedLoad['reason'], string> = {
  unverified: 'PELS has not verified this device’s Flow cards yet.',
  missing_both: 'PELS could not find “Stepped device target changed” or “Report stepped load” for this device.',
  missing_trigger: 'PELS could not find “Stepped device target changed” for this device.',
  missing_report: 'PELS could not find “Report stepped load” for this device.',
};

function pendingSetupMessage(deviceId: string, pending: PendingSteppedLoad): string {
  if (!resolveManagedState(deviceId)) {
    return UNMANAGED_FLOW_SETUP;
  }
  return `${pendingMessages[pending.reason]} PELS uses Default control until both cards are in place.`;
}

export function renderSteppedLoadFlowSetup(device: SettingsUiDeviceView): void {
  if (!setup || !status) return;
  const pending = device.pendingSteppedLoad;
  setup.hidden = pending === undefined;
  if (checkButton) checkButton.hidden = !resolveManagedState(device.id);
  status.textContent = pending
    ? pendingSetupMessage(device.id, pending)
    : '';
}

export function showPendingSteppedLoadReminder(device: SettingsUiDeviceView): void {
  const pending = device.pendingSteppedLoad;
  if (!pending) return;
  const message = resolveManagedState(device.id)
    ? `${pendingMessages[pending.reason]} Default control is still active.`
    : UNMANAGED_FLOW_SETUP;
  void showToast(message, 'warn', { durationMs: ERROR_DURATION_MS });
}

export function initSteppedLoadFlowCheck(onRefreshed: () => void): void {
  checkButton?.addEventListener('click', async () => {
    checkButton.disabled = true;
    try {
      await refreshFlowConflictFactsExplicit();
      state.latestDevices = await getTargetDevices();
      onRefreshed();
    } catch (error) {
      void showToastError(error, 'Could not check Homey Flows. Try again.');
    } finally {
      checkButton.disabled = false;
    }
  });
}
