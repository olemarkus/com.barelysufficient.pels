import type { EvCarChargerMatchHistory } from '../evCarLink.js';
import type { AssociatedCarSnapshot, CarConfirmation, ObservedStateOfCharge } from '../types.js';

export type SettingsUiCarAssociationConfirmation = {
  carConfirmation?: CarConfirmation;
  associatedCar?: AssociatedCarSnapshot;
  stateOfCharge?: ObservedStateOfCharge;
};

export type SettingsUiRecommendationCar = {
  id: string;
  name: string;
  /** Whether PELS observes the car now; only an observed car can be confirmed on a charger. */
  available: boolean;
  matchHistory: EvCarChargerMatchHistory;
};

export type SettingsUiRecommendationCarsRead =
  | { state: 'resolved'; cars: SettingsUiRecommendationCar[] }
  | { state: 'unavailable' };
