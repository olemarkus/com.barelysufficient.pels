import { readHubMarket } from '../../lib/home/hubMarket';
import { readWebAppVersion } from '../../lib/app/webAppVersion';
import { createHomeyWebApiGet } from '../homeyWebApi';
import { defineRoutes, type ApiContext } from './defineRoutes';

export const webAppRoutes = defineRoutes({
  ui_version: ({ homey }: ApiContext) => readWebAppVersion(homey),
  ui_hub_market: () => readHubMarket(createHomeyWebApiGet()),
});
