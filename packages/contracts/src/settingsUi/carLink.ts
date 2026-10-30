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
  matchHistory: EvCarChargerMatchHistory;
};

export type SettingsUiRecommendationCarsRead =
  | { state: 'resolved'; cars: SettingsUiRecommendationCar[] }
  | { state: 'unavailable' };
