import { render } from 'preact';
import { dispatchOpenDeviceDetail } from './cardActivation.ts';
import { buildDeadlineHref, followDeadlineHref } from './deadlineUrls.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import { refreshHomeScopeAndNotify } from './homeScope.ts';
import { saveDevicePriceEnabled } from './priceOptimization.ts';
import { keepAssumedPriceSource, readSetupGoalContext, resolveSetupGoalChoices } from './setupGoals.ts';
import { isSolarSetupJourney, setupSavePending, trackSetupSave } from './setupJourneyState.ts';
import { notifySetupPathChange } from './setupPathFacts.ts';
import { dispatchOpenSmartTaskCreateFromSetup } from './smartTaskCreate.ts';
import { showToastError } from './toast.ts';
import { SetupGoalPicker } from './views/SetupJourney.tsx';

/** `Choose what PELS does`, drawn where the device list goes; `rerender` repaints it after a save. */
export const renderSetupGoals = (
  devices: SettingsUiDeviceListItem[],
  target: HTMLElement,
  rerender: () => void,
): void => {
  if (!target.querySelector('.setup-journey__devices')) target.replaceChildren();
  render(SetupGoalPicker({
    choices: resolveSetupGoalChoices(devices, readSetupGoalContext(isSolarSetupJourney())),
    busy: setupSavePending(),
    onPrice: (id, enabled) => {
      void trackSetupSave(`price:${id}`, async () => {
        if (enabled) await keepAssumedPriceSource();
        await saveDevicePriceEnabled(id, enabled);
      })
        .catch((error) => showToastError(error, 'Failed to update price optimization settings.'))
        .finally(() => { rerender(); notifySetupPathChange(); });
    },
    onNewSmartTask: dispatchOpenSmartTaskCreateFromSetup,
    onOpenSmartTask: (id) => followDeadlineHref(buildDeadlineHref(id)),
    onOpen: dispatchOpenDeviceDetail,
    onRetry: () => { void refreshHomeScopeAndNotify(); },
  }), target);
};
