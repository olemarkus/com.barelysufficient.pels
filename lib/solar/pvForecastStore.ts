/**
 * The ports the PV-forecast controller consumes, declared by the domain that
 * needs them. `setup/pvForecastStateAdapter.ts` implements the store on
 * `homey.settings`, and `setup/homeyLocationAdapter.ts` implements the
 * coordinate read — only those adapters know about Homey (`setup/AGENTS.md`
 * § "Adapter naming": the port type lives in the domain).
 */
import type { PvForecastServiceState } from './pvForecastService';

/**
 * The boot read, classified at the adapter seam. `unreadable` is not absence:
 * it is a read this process could not believe, and the write gate treats the
 * two in opposite directions.
 */
export type PvForecastStateRead =
  | { kind: 'loaded'; state: PvForecastServiceState }
  | { kind: 'absent' }
  | { kind: 'marker_only' }
  | { kind: 'unreadable'; reason: 'read_threw' | 'malformed' | 'absence_unproven' };

export type PvForecastStore = {
  read: () => PvForecastStateRead;
  write: (state: PvForecastServiceState) => void;
};

export type HubCoordinates = { latitude: number; longitude: number };

export type HubCoordinatesResult =
  | { kind: 'resolved'; coordinates: HubCoordinates }
  | { kind: 'unavailable'; outcome: 'failed' | 'no_location' };
