import { resolveChipConfidence } from '../../packages/shared-domain/src/deadlineLabels';
import type {
  DeferredObjectiveKwhPerUnitProvenanceV1,
} from '../../packages/contracts/src/deferredObjectiveActivePlans';

const learnedProvenance = (
  overrides: Partial<DeferredObjectiveKwhPerUnitProvenanceV1> = {},
): DeferredObjectiveKwhPerUnitProvenanceV1 => ({
  source: 'learned',
  kWhPerUnit: 0.4,
  acceptedSamples: 12,
  confidence: 'low',
  displayConfidence: undefined,
  lastAcceptedAtMs: null,
  ...overrides,
});

describe('resolveChipConfidence', () => {
  it('returns null when the plan carries no provenance', () => {
    expect(resolveChipConfidence(undefined)).toBe(null);
  });

  it('prefers displayConfidence from provenance when present', () => {
    expect(resolveChipConfidence(learnedProvenance({ confidence: 'low', displayConfidence: 'high' }))).toBe('high');
  });

  it('falls back to provenance.confidence when displayConfidence is missing', () => {
    expect(resolveChipConfidence(learnedProvenance({ confidence: 'medium' }))).toBe('medium');
  });

  it('treats bootstrap provenance (null confidences) as no signal', () => {
    expect(resolveChipConfidence({
      source: 'bootstrap',
      kWhPerUnit: null,
      acceptedSamples: 0,
      confidence: null,
      lastAcceptedAtMs: null,
    })).toBe(null);
  });
});
