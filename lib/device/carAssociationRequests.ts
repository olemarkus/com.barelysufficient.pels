import type { DeviceTransportPort } from './deviceTransport';
import { API_STARTING_MESSAGE, ApiRequestError } from '../utils/apiRequestError';
import type { SettingsUiCarAssociationConfirmation } from '../../packages/contracts/src/settingsUi/carLink';

/** Validate a car-link request before requiring the transport, then apply the device owner's operation. */
export function confirmCarAssociationRequest(
  transport: DeviceTransportPort | undefined,
  body: unknown,
): SettingsUiCarAssociationConfirmation {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !('chargerId' in body) || typeof body.chargerId !== 'string' || !body.chargerId.trim()
    || !('carId' in body) || typeof body.carId !== 'string' || !body.carId.trim()) {
    throw new ApiRequestError('Choose a charger and a car.');
  }
  if (!transport) throw new Error(API_STARTING_MESSAGE);
  transport.confirmCarAssociation(body.chargerId, body.carId);
  return readConfirmation(transport, body.chargerId);
}

export function clearCarAssociationRequest(
  transport: DeviceTransportPort | undefined,
  body: unknown,
): SettingsUiCarAssociationConfirmation {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !('chargerId' in body) || typeof body.chargerId !== 'string' || !body.chargerId.trim()) {
    throw new ApiRequestError('Choose a charger.');
  }
  if (!transport) throw new Error(API_STARTING_MESSAGE);
  transport.clearCarConfirmation(body.chargerId);
  return readConfirmation(transport, body.chargerId);
}

function readConfirmation(
  transport: DeviceTransportPort,
  chargerId: string,
): SettingsUiCarAssociationConfirmation {
  // The transport owns this already-resolved level. Publish only that level,
  // never its raw report or session/source bookkeeping.
  const charge = transport.getSnapshotByDeviceId(chargerId)?.stateOfCharge;
  return {
    carConfirmation: transport.getCarConfirmation(chargerId),
    associatedCar: transport.getAssociatedCar(chargerId),
    ...(charge ? { stateOfCharge: { level: charge.level } } : {}),
  };
}
