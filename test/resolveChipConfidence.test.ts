import { resolveChipConfidence } from '../packages/shared-domain/src/deadlineLabels';
import type {
  DeferredObjectiveKwhPerUnitProvenanceV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';

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
  it('returns null when no provenance and no profile confidence are available', () => {
    expect(resolveChipConfidence({ provenance: undefined, profileConfidence: null })).toBe(null);
    expect(resolveChipConfidence({ provenance: undefined, profileConfidence: undefined })).toBe(null);
  });

  it('prefers displayConfidence from provenance when present', () => {
    expect(resolveChipConfidence({
      provenance: learnedProvenance({ confidence: 'low', displayConfidence: 'high' }),
      profileConfidence: 'medium',
    })).toBe('high');
  });

  it('falls back to provenance.confidence when displayConfidence is missing', () => {
    expect(resolveChipConfidence({
      provenance: learnedProvenance({ confidence: 'medium' }),
      profileConfidence: 'low',
    })).toBe('medium');
  });

  it('falls back to live profile confidence when provenance has no values', () => {
    expect(resolveChipConfidence({
      provenance: undefined,
      profileConfidence: 'high',
    })).toBe('high');
  });

  it('treats bootstrap provenance (null confidences) as no signal — falls through to live profile', () => {
    expect(resolveChipConfidence({
      provenance: {
        source: 'bootstrap',
        kWhPerUnit: null,
        acceptedSamples: 0,
        confidence: null,
        lastAcceptedAtMs: null,
      },
      profileConfidence: 'medium',
    })).toBe('medium');
  });
});
