// The app-API entry point: every route Homey dispatches by the `api` keys in
// `.homeycompose/app.json`. Each endpoint family owns its table under
// `setup/api/`; `npm run api:manifest-parity` checks this union against the
// manifest.
import { carLinkRoutes } from './setup/api/carLinkRoutes';
import { chargingControlRoutes } from './setup/api/chargingControlRoutes';
import { dailyBudgetRoutes } from './setup/api/dailyBudgetRoutes';
import { diagnosticsDebugRoutes } from './setup/api/diagnosticsDebugRoutes';
import { homesRoutes } from './setup/api/homesRoutes';
import { pricesRoutes } from './setup/api/pricesRoutes';
import { recommendationRoutes } from './setup/api/recommendationRoutes';
import { settingsUiCoreRoutes } from './setup/api/settingsUiCoreRoutes';
import { smartTaskRoutes } from './setup/api/smartTaskRoutes';
import { starvationRescueRoutes } from './setup/api/starvationRescueRoutes';
import { supportReportRoutes } from './setup/api/supportReportRoutes';
import { webAppRoutes } from './setup/api/webAppRoutes';

export = {
  ...settingsUiCoreRoutes,
  ...homesRoutes,
  ...pricesRoutes,
  ...dailyBudgetRoutes,
  ...smartTaskRoutes,
  ...starvationRescueRoutes,
  ...supportReportRoutes,
  ...chargingControlRoutes,
  ...carLinkRoutes,
  ...recommendationRoutes,
  ...diagnosticsDebugRoutes,
  ...webAppRoutes,
};
