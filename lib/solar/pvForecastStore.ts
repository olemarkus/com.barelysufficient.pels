/**
 * The ports the PV-forecast controller consumes, declared by the domain that
 * needs them. `lib/solar/pvForecastStateStore.ts` implements the store on the
 * userdata database, and `setup/homeyLocationAdapter.ts` implements the
 * coordinate read (`setup/AGENTS.md` § "Adapter naming": the port type lives
 * in the domain).
 */
import type { PvForecastServiceState } from './pvForecastService';

/**
 * A read of the store. `absent` is an affirmative answer: the store holds
 * nothing. `unreadable` is a read that threw, which is not absence, and the
 * write gate treats the two in opposite directions.
 */
export type PvForecastStateRead =
  | { kind: 'loaded'; state: PvForecastServiceState }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

export type PvForecastStore = {
  read: () => PvForecastStateRead;
  write: (state: PvForecastServiceState) => void;
};

export type HubCoordinates = { latitude: number; longitude: number };

export type HubCoordinatesResult =
  | { kind: 'resolved'; coordinates: HubCoordinates }
  | { kind: 'unavailable'; outcome: 'failed' | 'no_location' };
