import { readPelsHost } from '../../lib/app/pelsHost';
import { readObservedStateOfCharge } from '../../lib/observer/observedDeviceStateProjection';
import { ApiRequestError } from '../../lib/utils/apiRequestError';
import type { SettingsUiCarAssociationConfirmation } from '../../packages/contracts/src/settingsUiApi';
import { API_STARTING_MESSAGE, defineRoutes, type ApiContext } from './defineRoutes';

export const carLinkRoutes = defineRoutes({
  ui_car_association_confirm: (
    { homey, body }: ApiContext & { body?: unknown },
  ): SettingsUiCarAssociationConfirmation => {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !('chargerId' in body) || typeof body.chargerId !== 'string' || !body.chargerId.trim()
      || !('carId' in body) || typeof body.carId !== 'string' || !body.carId.trim()) {
      throw new ApiRequestError('Choose a charger and a car.');
    }
    const transport = readPelsHost(homey)?.deviceManager;
    if (!transport) throw new Error(API_STARTING_MESSAGE);
    transport.confirmCarAssociation(body.chargerId, body.carId);
    const charge = readObservedStateOfCharge(transport.getSnapshotByDeviceId(body.chargerId));
    return {
      carConfirmation: transport.getCarConfirmation(body.chargerId),
      associatedCar: transport.getAssociatedCar(body.chargerId),
      ...(charge.kind === 'observed' ? { stateOfCharge: charge.value } : {}),
    };
  },
  ui_car_association_clear: (
    { homey, body }: ApiContext & { body?: unknown },
  ): SettingsUiCarAssociationConfirmation => {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !('chargerId' in body) || typeof body.chargerId !== 'string' || !body.chargerId.trim()) {
      throw new ApiRequestError('Choose a charger.');
    }
    const transport = readPelsHost(homey)?.deviceManager;
    if (!transport) throw new Error(API_STARTING_MESSAGE);
    transport.clearCarConfirmation(body.chargerId);
    const charge = readObservedStateOfCharge(transport.getSnapshotByDeviceId(body.chargerId));
    return {
      carConfirmation: transport.getCarConfirmation(body.chargerId),
      associatedCar: transport.getAssociatedCar(body.chargerId),
      ...(charge.kind === 'observed' ? { stateOfCharge: charge.value } : {}),
    };
  },
});
