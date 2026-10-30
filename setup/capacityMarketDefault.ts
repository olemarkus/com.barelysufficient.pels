import { CapacityMarketDefault } from '../lib/power/capacityMarketDefault';
import type { SettingsPort } from '../lib/ports/homeyRuntime';
import type { InstallAtBoot } from '../lib/utils/settingsKeyList';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import { createHubMarketRead } from './appInit/hubMarketRead';

/** Construct the new-install Capacity limit default with its settings and hub-market collaborators, and start it. */
export const startCapacityMarketDefault = (
  settings: SettingsPort,
  timers: TimerRegistry,
  installAtBoot: InstallAtBoot,
): void => {
  new CapacityMarketDefault({
    installAtBoot,
    settings,
    readHubMarket: createHubMarketRead(),
    timers,
  }).start();
};
