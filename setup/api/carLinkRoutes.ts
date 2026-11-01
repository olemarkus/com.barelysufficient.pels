import { readPelsHost } from '../../lib/app/pelsHost';
import {
  clearCarAssociationFromUi,
  confirmCarAssociationFromUi,
  type CarAssociationUiTarget,
} from '../../lib/device/carAssociationUiApi';
import type { SettingsUiCarAssociationConfirmation } from '../../packages/contracts/src/settingsUi/carLink';
import { API_STARTING_MESSAGE, defineRoutes, type ApiContext } from './defineRoutes';

function carAssociation(homey: ApiContext['homey']): CarAssociationUiTarget {
  const transport = readPelsHost(homey)?.deviceManager;
  if (!transport) throw new Error(API_STARTING_MESSAGE);
  return transport;
}

// `lib/device` validates the request and answers the charger's car link.
export const carLinkRoutes = defineRoutes({
  ui_car_association_confirm: (
    { homey, body }: ApiContext & { body?: unknown },
  ): SettingsUiCarAssociationConfirmation => confirmCarAssociationFromUi(carAssociation(homey), body),
  ui_car_association_clear: (
    { homey, body }: ApiContext & { body?: unknown },
  ): SettingsUiCarAssociationConfirmation => clearCarAssociationFromUi(carAssociation(homey), body),
});
