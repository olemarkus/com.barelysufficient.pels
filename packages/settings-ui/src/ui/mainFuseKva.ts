import type { MainFuse, MainFuseSupply } from '../../../contracts/src/capacitySettings.ts';
import { isValidMainFuseAmps, mainFuseTotalKw } from '../../../shared-domain/src/settings/mainFuse.ts';

/**
 * The main fuse entered as a subscribed power in kVA, as French contracts state
 * it. Only the form converts: the stored fuse stays a supply and amps per phase,
 * so the runtime and its phase targets are unchanged. A subscription is split
 * evenly over the phases, which is what amps per phase already express.
 */
export type MainFuseEntryUnit = 'amps' | 'kva';

/** UI-only key: how the owner enters the fuse. Absent until they choose. */
export const MAIN_FUSE_ENTRY_UNIT_KEY = 'main_fuse_entry_unit';

export const resolveMainFuseEntryUnit = (raw: unknown): MainFuseEntryUnit | null => (
  raw === 'amps' || raw === 'kva' ? raw : null
);

/** Subscribed powers offered in France. */
const KVA_STEPS = [3, 6, 9, 12, 15, 18, 24, 30, 36] as const;

// What one amp per phase carries on this supply, in kVA (1 kVA taken as 1 kW).
const kvaPerAmp = (supply: MainFuseSupply): number => mainFuseTotalKw({ kind: 'on', supply, amps: 1 });

export const mainFuseAmpsFromKva = (kva: number, supply: MainFuseSupply): number => kva / kvaPerAmp(supply);

export const mainFuseKva = (fuse: Extract<MainFuse, { kind: 'on' }>): number => fuse.amps * kvaPerAmp(fuse.supply);

/** The steps whose per-phase current is a fuse PELS accepts on this supply. */
export const mainFuseKvaSteps = (supply: MainFuseSupply): number[] => (
  KVA_STEPS.filter((kva) => isValidMainFuseAmps(mainFuseAmpsFromKva(kva, supply)))
);

const SAME_FUSE_TOLERANCE_A = 1e-6;

/** The step a stored fuse was saved from, or null for a fuse entered in amps. */
export const matchingMainFuseKvaStep = (fuse: Extract<MainFuse, { kind: 'on' }>): number | null => (
  mainFuseKvaSteps(fuse.supply).find((kva) => (
    Math.abs(mainFuseAmpsFromKva(kva, fuse.supply) - fuse.amps) < SAME_FUSE_TOLERANCE_A
  )) ?? null
);

/** Amps as the size field shows them: whole amps stay whole, a converted size gets one decimal. */
export const formatMainFuseAmps = (amps: number): string => (
  Number.isInteger(amps) ? String(amps) : amps.toFixed(1)
);
