import { render } from 'preact';
import { dispatchOpenDeviceDetail } from './cardActivation.ts';
import { buildDeadlineHref, followDeadlineHref } from './deadlineUrls.ts';
import { refreshHomeScopeAndNotify } from './homeScope.ts';
import { saveDevicePriceEnabled } from './priceOptimization.ts';
import { keepAssumedPriceSource, resolveSetupGoalChoices } from './setupGoals.ts';
import { saveSetupBatteryPlan } from './setupBatteryPlan.ts';
import { setupSavePending, trackSetupSave } from './setupJourneyState.ts';
import { notifySetupPathChange } from './setupPathFacts.ts';
import { dispatchOpenSmartTaskCreateFromSetup } from './smartTaskCreate.ts';
import { showToastError } from './toast.ts';
import { SetupGoalPicker } from './views/SetupJourney.tsx';

/**
 * A Smart task saved from this page keeps the price source as Price-based
 * control does, as a tracked setup save so Continue waits for it and a failure
 * is shown.
 */
export const keepPriceSourceForSetupTask = (): void => {
  void trackSetupSave('price-source', keepAssumedPriceSource)
    .catch((error) => showToastError(error, 'Failed to save the price source.'));
};

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
    onBatteryPlan: (id, enabled, capacityKWh) => {
      // A plan runs on prices, so turning one on keeps an assumed source as
      // Price-based control does.
      return trackSetupSave(`battery-plan:${id}`, async () => {
        await saveSetupBatteryPlan(id, enabled, capacityKWh);
        if (enabled) await keepAssumedPriceSource();
      })
        .catch((error: unknown) => {
          // The row can remount after capacity saves, or disappear on navigation.
          void showToastError(error, 'Battery plan could not be saved. Try again.');
          throw error;
        })
        .finally(() => { rerender(); notifySetupPathChange(); });
    },
    onNewSmartTask: dispatchOpenSmartTaskCreateFromSetup,
    onOpenSmartTask: (id) => followDeadlineHref(buildDeadlineHref(id)),
    onOpen: dispatchOpenDeviceDetail,
    onRetry: () => { void refreshHomeScopeAndNotify(); },
  }), target);
};
