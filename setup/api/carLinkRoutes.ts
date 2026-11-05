import { readPelsHost } from '../../lib/app/pelsHost';
import { confirmCarAssociationRequest, clearCarAssociationRequest } from '../../lib/device/carAssociationRequests';
import { defineRoutes, type ApiContext } from './defineRoutes';

type CarAssociationRequest = ApiContext & { body?: unknown };

export const carLinkRoutes = defineRoutes({
  ui_car_association_confirm: ({ homey, body }: CarAssociationRequest) => (
    confirmCarAssociationRequest(readPelsHost(homey)?.deviceManager, body)
  ),
  ui_car_association_clear: ({ homey, body }: CarAssociationRequest) => (
    clearCarAssociationRequest(readPelsHost(homey)?.deviceManager, body)
  ),
});
