import { deviceDetailBudgetExempt } from '../dom.ts';
import { state } from '../state.ts';
import { BUDGET_EXEMPT_DEVICES } from '../../../../contracts/src/settingsKeys.ts';
import { readRecordSettingStrict, writeFreshSetting } from './settingsWrite.ts';
import type { SettingsUiDeviceDetailItem } from '../deviceUtils.ts';

// Reflects the persisted/optimistic budget-exempt flag onto the toggle. Always
// enabled — the standing per-device exemption is not cause-gated.
export const setDeviceDetailBudgetExemptState = (device: SettingsUiDeviceDetailItem | null): void => {
  if (!deviceDetailBudgetExempt || !device) return;
  deviceDetailBudgetExempt.selected = state.budgetExemptMap[device.id] === true || device.budgetExempt === true;
  deviceDetailBudgetExempt.disabled = false;
};

type BudgetExemptHandlerDeps = {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
  refreshSharedDeviceViews: () => void;
  refreshOpenDeviceDetail: () => void;
};

// Mirror the new flag onto the live device object so the shared views render
// the change before the next snapshot arrives.
const updateCurrentDeviceBudgetExemptSnapshot = (
  getDeviceById: BudgetExemptHandlerDeps['getDeviceById'],
  deviceId: string,
  budgetExempt: boolean,
): void => {
  const device = getDeviceById(deviceId);
  if (device) device.budgetExempt = budgetExempt;
};

export const initDeviceDetailBudgetExemptHandler = ({
  getCurrentDetailDeviceId,
  getDeviceById,
  refreshSharedDeviceViews,
  refreshOpenDeviceDetail,
}: BudgetExemptHandlerDeps): void => {
  deviceDetailBudgetExempt?.addEventListener('change', async () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailBudgetExempt) return;

    const nextChecked = deviceDetailBudgetExempt.selected;
    await writeFreshSetting<Record<string, boolean>>({
      key: BUDGET_EXEMPT_DEVICES,
      context: 'device detail',
      logMessage: 'Failed to update budget exempt device',
      toastMessage: 'Failed to update budget exempt device.',
      // Use the live budget-exempt snapshot as the fallback so a transient
      // null SDK read does not erase entries for other devices.
      fallbackValue: state.budgetExemptMap,
      readFresh: readRecordSettingStrict<boolean>,
      mutate: (currentMap) => {
        const nextMap = { ...currentMap };
        if (nextChecked) {
          nextMap[deviceId] = true;
        } else {
          delete nextMap[deviceId];
        }
        return nextMap;
      },
      commit: (nextMap) => {
        state.budgetExemptMap = nextMap;
        updateCurrentDeviceBudgetExemptSnapshot(getDeviceById, deviceId, nextChecked);
        refreshSharedDeviceViews();
        refreshOpenDeviceDetail();
      },
      rollback: refreshOpenDeviceDetail,
    });
  });
};
