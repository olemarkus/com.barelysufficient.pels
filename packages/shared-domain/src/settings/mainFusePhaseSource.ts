import { isUnknownRecord } from '../recordGuards';

export type MainFusePhaseFacet = 'power' | 'current';

/** The meter capabilities the owner chose as each phase, all of one facet. */
export type MainFusePhaseCapabilities = {
  facet: MainFusePhaseFacet;
  L1: string;
  L2: string;
  L3: string;
};

const FACET_PREFIX: Record<MainFusePhaseFacet, string> = {
  power: 'measure_power.',
  current: 'measure_current.',
};

/** Whether a capability id can stand for a phase of this facet. */
export const isPhaseCapabilityOf = (facet: MainFusePhaseFacet, capabilityId: string): boolean => (
  capabilityId.startsWith(FACET_PREFIX[facet])
);

/** The facet a capability id belongs to, or null when it can be neither. */
export const resolvePhaseCapabilityFacet = (capabilityId: string): MainFusePhaseFacet | null => {
  if (isPhaseCapabilityOf('power', capabilityId)) return 'power';
  return isPhaseCapabilityOf('current', capabilityId) ? 'current' : null;
};

export const isMainFusePhaseCapabilities = (value: unknown): value is MainFusePhaseCapabilities => {
  if (!isUnknownRecord(value) || (value.facet !== 'power' && value.facet !== 'current')) return false;
  const { facet, L1, L2, L3 } = value;
  return [L1, L2, L3].every((id) => typeof id === 'string' && isPhaseCapabilityOf(facet, id));
};
