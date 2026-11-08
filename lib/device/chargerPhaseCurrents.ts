import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';

type CapabilityRecord = Record<string, { value?: unknown } | undefined>;
type PhaseCurrents = NonNullable<TransportDeviceSnapshot['chargerPhaseCurrentsA']>;

const PHASE_CURRENT_CAPABILITY = /^measure_current\.(?:l|p|phase_?)([123])$/iu;

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
    const phase = PHASE_CURRENT_CAPABILITY.exec(id)?.[1];
    return phase === undefined ? [] : [[phase, id] as const];
  }));
  const [l1, l2, l3] = ['1', '2', '3'].map((phase) => idByPhase.get(phase));
  if (l1 === undefined || l2 === undefined || l3 === undefined) return undefined;
  const currents = [l1, l2, l3].map((id) => usableAmps(capabilities[id]?.value));
  const [a, b, c] = currents;
  return a === undefined || b === undefined || c === undefined ? previous : [a, b, c];
}
