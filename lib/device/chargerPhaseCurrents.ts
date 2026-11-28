import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { EvChargingState } from '../../packages/contracts/src/types';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';

type CapabilityRecord = Record<string, { value?: unknown } | undefined>;
type PhaseCurrents = NonNullable<TransportDeviceSnapshot['chargerPhaseCurrentsA']>;

const PHASE_CURRENT_CAPABILITY = /^measure_current\.(?:(?:l|p|phase_?)([123])|phase_?([abc]))$/iu;
const PHASE_LETTER_NUMBER: Readonly<Record<string, string>> = { a: '1', b: '2', c: '3' };

const usableAmps = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
);

/**
 * An EV charger's own per-phase current. Charger apps name these capabilities
 * differently, so recognition is by pattern, as for a meter (`meterPhases.ts`).
 * Only a charger declaring all three has a picture of its phases. A declared
 * set with an unusable value keeps the previous reading: a transient bad sample
 * is not a charger that stopped having phases.
 */
export function resolveChargerPhaseCurrentsA(
  device: object,
  previous: PhaseCurrents | undefined,
): PhaseCurrents | undefined {
  const capabilities = ((device as { capabilitiesObj?: unknown }).capabilitiesObj ?? {}) as CapabilityRecord;
  const idByPhase = new Map(Object.keys(capabilities).flatMap((id) => {
    const match = PHASE_CURRENT_CAPABILITY.exec(id);
    const phase = match?.[1] ?? (match?.[2] ? PHASE_LETTER_NUMBER[match[2].toLowerCase()] : undefined);
    return phase === undefined ? [] : [[phase, id] as const];
  }));
  const [l1, l2, l3] = ['1', '2', '3'].map((phase) => idByPhase.get(phase));
  if (l1 === undefined || l2 === undefined || l3 === undefined) return undefined;
  const currents = [l1, l2, l3].map((id) => usableAmps(capabilities[id]?.value));
  const [a, b, c] = currents;
  return a === undefined || b === undefined || c === undefined ? previous : [a, b, c];
}

/** A charger phase at or below this is not carrying the car. */
const DRAWING_PHASE_A = 1;

/**
 * The most phases the car has drawn on in this plug-in session. Each of the
 * three currents arrives on its own, so one reading can catch a three-phase car
 * half way through a ramp-down; the session keeps its highest count instead. An
 * observed plug-out ends the session; an unreadable plug state keeps it.
 */
export function resolveChargerSessionDrawPhases(
  currentsA: PhaseCurrents | undefined,
  evChargingState: EvChargingState | undefined,
  previous: 1 | 2 | 3 | undefined,
): 1 | 2 | 3 | undefined {
  if (evChargingState !== undefined && !isEvPlugStateConnected(evChargingState)) return undefined;
  const drawing = currentsA?.filter((amps) => amps > DRAWING_PHASE_A).length ?? 0;
  if (drawing !== 1 && drawing !== 2 && drawing !== 3) return previous;
  return previous === undefined || drawing > previous ? drawing : previous;
}
