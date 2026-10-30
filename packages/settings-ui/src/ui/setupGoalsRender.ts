import { render } from 'preact';
import { dispatchOpenDeviceDetail } from './cardActivation.ts';
import { buildDeadlineHref, followDeadlineHref } from './deadlineUrls.ts';
import { refreshHomeScopeAndNotify } from './homeScope.ts';
import { saveDevicePriceEnabled } from './priceOptimization.ts';
import { keepAssumedPriceSource, resolveSetupGoalChoices } from './setupGoals.ts';
import { setupSavePending, trackSetupSave } from './setupJourneyState.ts';
import { notifySetupPathChange } from './setupPathFacts.ts';
import { dispatchOpenSmartTaskCreateFromSetup } from './smartTaskCreate.ts';
import { showToastError } from './toast.ts';
import { SetupGoalPicker } from './views/SetupJourney.tsx';

/** `Choose what PELS does`, drawn where the device list goes; `rerender` repaints it after a save. */
export const renderSetupGoals = (target: HTMLElement, rerender: () => void): void => {
  if (!target.querySelector('.setup-journey__devices')) target.replaceChildren();
  render(SetupGoalPicker({
    choices: resolveSetupGoalChoices(),
    busy: setupSavePending(),
    onPrice: (id, enabled) => {
      // The device's choice lands first: keeping the source fires a reload of
      // the price settings, which must read the map this save just wrote.
      void trackSetupSave(`price:${id}`, async () => {
        await saveDevicePriceEnabled(id, enabled);
        if (enabled) await keepAssumedPriceSource();
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
