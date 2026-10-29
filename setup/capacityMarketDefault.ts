import { CapacityMarketDefault, type InstallAtBoot } from '../lib/power/capacityMarketDefault';
import type { SettingsPort } from '../lib/ports/homeyRuntime';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import { createHubMarketRead } from './appInit/hubMarketRead';

export { classifyInstallAtBoot, type InstallAtBoot } from '../lib/power/capacityMarketDefault';

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
