import type { AppContext } from '../../lib/app/appContext';
import { initSettingsHandlerForApp } from '../appSettingsHelpers';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';
import { buildHomeRuntimeSettingsHooks } from './wireHomeRuntimeRegistry';

export const registerSettingsHandler = (params: {
  ctx: AppContext;
  getHomeRuntimeRegistry: () => HomeRuntimeRegistry | undefined;
  requestMainAuthorityRecovery: (timing?: 'scheduled' | 'immediate') => void;
  observeOwnershipConfigurationChanged: () => void;
}): (() => void) => {
  const settingsHandler = initSettingsHandlerForApp(params.ctx, {
    ...buildHomeRuntimeSettingsHooks(params.getHomeRuntimeRegistry),
    onHomeyEnergyMeterObserved: () => params.ctx.homeyEnergyHelpers.invalidate(),
    onMainMeterSelectionObserved: () => params.requestMainAuthorityRecovery(),
    onHomeOwnershipConfigurationObserved: params.observeOwnershipConfigurationChanged,
    onHomeOwnershipConfigurationRecomputed: () => params.requestMainAuthorityRecovery('immediate'),
  });
  return settingsHandler.stop;
};
