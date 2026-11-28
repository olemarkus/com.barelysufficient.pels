import { ExportPriceMarketDefault } from '../lib/price/exportPriceMarketDefault';
import type { SettingsPort } from '../lib/ports/homeyRuntime';
import type { InstallAtBoot } from '../lib/utils/settingsKeyList';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import { createHubMarketRead } from './appInit/hubMarketRead';

/** Construct the new-install export price default with its settings and hub-market collaborators, and start it. */
export const startExportPriceMarketDefault = (
  settings: SettingsPort,
  timers: TimerRegistry,
  installAtBoot: InstallAtBoot,
): void => {
  new ExportPriceMarketDefault({
    installAtBoot,
    settings,
    readHubMarket: createHubMarketRead(),
    timers,
  }).start();
};
