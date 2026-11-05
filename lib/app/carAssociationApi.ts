import { readPelsHost, API_STARTING_MESSAGE } from './pelsHost';
import type { DeviceTransportPort } from '../device/deviceTransport';
import { readObservedStateOfCharge } from '../observer/observedDeviceStateProjection';
import { ApiRequestError } from '../utils/apiRequestError';
import type { SettingsUiCarAssociationConfirmation } from '../../packages/contracts/src/settingsUi/carLink';

type CarAssociationRequest = { homey: { readonly app?: unknown }; body?: unknown };

export const carAssociationApi = {
  ui_car_association_confirm: (
    { homey, body }: CarAssociationRequest,
  ): SettingsUiCarAssociationConfirmation => {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !('chargerId' in body) || typeof body.chargerId !== 'string' || !body.chargerId.trim()
      || !('carId' in body) || typeof body.carId !== 'string' || !body.carId.trim()) {
      throw new ApiRequestError('Choose a charger and a car.');
    }
    const transport = readPelsHost(homey)?.deviceManager;
    if (!transport) throw new Error(API_STARTING_MESSAGE);
    transport.confirmCarAssociation(body.chargerId, body.carId);
    return readConfirmation(transport, body.chargerId);
  },
  ui_car_association_clear: (
    { homey, body }: CarAssociationRequest,
  ): SettingsUiCarAssociationConfirmation => {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !('chargerId' in body) || typeof body.chargerId !== 'string' || !body.chargerId.trim()) {
      throw new ApiRequestError('Choose a charger.');
    }
    const transport = readPelsHost(homey)?.deviceManager;
    if (!transport) throw new Error(API_STARTING_MESSAGE);
    transport.clearCarConfirmation(body.chargerId);
    return readConfirmation(transport, body.chargerId);
  },
};

function readConfirmation(transport: DeviceTransportPort, chargerId: string): SettingsUiCarAssociationConfirmation {
  const charge = readObservedStateOfCharge(transport.getSnapshotByDeviceId(chargerId));
  return {
    carConfirmation: transport.getCarConfirmation(chargerId),
    associatedCar: transport.getAssociatedCar(chargerId),
    ...(charge.kind === 'observed' ? { stateOfCharge: charge.value } : {}),
  };
}
