import type { MainFusePhaseCapabilities } from '../../packages/shared-domain/src/settings/mainFusePhaseSource';
import type { MeterPhasesRead, PhaseTriple } from '../ports/homeMeterReadings';

type CapabilityRecord = Record<string, { value?: unknown } | undefined>;

// Phases are numbered (`l1`, `p1`, `phase_1`) or lettered (`phase_a`, as some HAN readers name them).
const PHASE_CAPABILITY = /^measure_(power|current|voltage)\.(?:(?:l|p|phase_?)([123])|phase_?([abc]))$/iu;
const PHASE_LETTER_NUMBER: Readonly<Record<string, string>> = { a: '1', b: '2', c: '3' };
const SPLIT_POWER_CAPABILITY = /^measure_power\.l([123])([ie])$/iu;

type Facet = 'power' | 'current' | 'voltage';
const PHASE_NUMBERS = ['1', '2', '3'] as const;

const finite = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const toTriple = (values: readonly (number | undefined)[]): PhaseTriple | undefined => {
  const [a, b, c] = values;
  return a === undefined || b === undefined || c === undefined ? undefined : [a, b, c];
};

// Some meter apps publish import and export per phase as two positive numbers.
const readSplitPower = (capabilities: CapabilityRecord, ids: readonly string[]): PhaseTriple | undefined => {
  const byKey = new Map(ids.flatMap((id) => {
    const [, phase, direction] = SPLIT_POWER_CAPABILITY.exec(id) ?? [];
    return phase && direction ? [[`${phase}${direction.toLowerCase()}`, finite(capabilities[id]?.value)] as const] : [];
  }));
  return toTriple(PHASE_NUMBERS.map((phase) => {
    const imported = byKey.get(`${phase}i`);
    const exported = byKey.get(`${phase}e`);
    return imported === undefined || exported === undefined ? undefined : imported - exported;
  }));
};

const readFacet = (
  capabilities: CapabilityRecord,
  ids: readonly string[],
  facet: Facet,
): PhaseTriple | undefined => {
  // A meter may name one phase twice (`l1` and `phase1`); a broken alias must not hide a good one.
  const byPhase = new Map(ids.flatMap((id) => {
    const [, name, numbered, lettered] = PHASE_CAPABILITY.exec(id) ?? [];
    const phase = numbered ?? (lettered ? PHASE_LETTER_NUMBER[lettered.toLowerCase()] : undefined);
    const value = finite(capabilities[id]?.value);
    return name?.toLowerCase() === facet && phase && value !== undefined ? [[phase, value] as const] : [];
  }));
  return toTriple(PHASE_NUMBERS.map((phase) => byPhase.get(phase)));
};

/** The owner's chosen capabilities, read like recognised ones: all three finite, or no phases. */
const resolveOwnerChosenPhases = (
  capabilities: CapabilityRecord,
  capabilityIds: readonly string[],
  choice: MainFusePhaseCapabilities,
): MeterPhasesRead => {
  const values = toTriple([choice.L1, choice.L2, choice.L3].map((id) => finite(capabilities[id]?.value)));
  if (values === undefined) return { state: 'none', capabilityIds };
  return { state: 'read', capabilityIds, ...(choice.facet === 'power' ? { powerW: values } : { currentA: values }) };
};

/**
 * Resolve a meter's per-phase capabilities at the device boundary. Meter apps
 * name them differently, so recognition is by pattern. A facet missing a phase
 * or a finite value is absent as a whole: half a picture would show room that
 * is not there.
 */
export function resolveMeterPhases(
  device: object,
  ownerChoice: MainFusePhaseCapabilities | null,
): MeterPhasesRead {
  const capabilities = ((device as { capabilitiesObj?: unknown }).capabilitiesObj ?? {}) as CapabilityRecord;
  const ids = Object.keys(capabilities);
  const capabilityIds = ids.filter((id) => id.startsWith('measure_'));
  if (ownerChoice !== null) return resolveOwnerChosenPhases(capabilities, capabilityIds, ownerChoice);
  const powerW = readFacet(capabilities, ids, 'power') ?? readSplitPower(capabilities, ids);
  const currentA = readFacet(capabilities, ids, 'current');
  const voltageV = readFacet(capabilities, ids, 'voltage');
  if (powerW === undefined && currentA === undefined) return { state: 'none', capabilityIds };
  return {
    state: 'read',
    capabilityIds,
    ...(powerW ? { powerW } : {}),
    ...(currentA ? { currentA } : {}),
    ...(voltageV ? { voltageV } : {}),
  };
}
