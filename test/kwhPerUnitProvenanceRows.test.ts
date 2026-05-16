import {
  resolveKwhPerUnitProvenanceRows,
} from '../packages/shared-domain/src/deadlineLabels';
import type {
  DeferredObjectiveKwhPerUnitProvenanceV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';

// Producer-side resolution: the UI just renders these rows verbatim. The tests
// here pin the row composition so any future drift in copy or omitted-field
// behaviour shows up here before the UI test catches it.

const ACCEPTED_AT_MS = Date.UTC(2026, 4, 14, 12, 30);
const STUB_ACCEPTED_AT = 'May 14 12:30';
const formatAcceptedAt = (ms: number): string => (
  ms === ACCEPTED_AT_MS ? STUB_ACCEPTED_AT : `t=${ms}`
);

describe('resolveKwhPerUnitProvenanceRows', () => {
  it('returns an empty list when provenance is absent', () => {
    expect(resolveKwhPerUnitProvenanceRows({
      provenance: undefined,
      unitSuffix: 'kWh/%',
      formatAcceptedAt,
    })).toEqual([]);
  });

  it('renders a single "Bootstrap estimate" source row for bootstrap provenance', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'bootstrap',
      kWhPerUnit: null,
      acceptedSamples: 0,
      confidence: null,
      lastAcceptedAtMs: null,
    };
    expect(resolveKwhPerUnitProvenanceRows({
      provenance,
      unitSuffix: 'kWh/%',
      formatAcceptedAt,
    })).toEqual([{ label: 'Source', value: 'Bootstrap estimate' }]);
  });

  it('renders source/learned-rate/samples/last-sample rows for fully-populated learned provenance', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.42,
      acceptedSamples: 12,
      confidence: 'medium',
      lastAcceptedAtMs: ACCEPTED_AT_MS,
    };
    expect(resolveKwhPerUnitProvenanceRows({
      provenance,
      unitSuffix: 'kWh/%',
      formatAcceptedAt,
    })).toEqual([
      { label: 'Source', value: 'Learned profile' },
      { label: 'Learned rate', value: '0.42 kWh/%' },
      { label: 'Samples', value: '12 accepted samples · medium confidence' },
      { label: 'Last sample', value: STUB_ACCEPTED_AT },
    ]);
  });

  it('omits the learned-rate row when the mean is missing or non-positive', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: null,
      acceptedSamples: 3,
      confidence: 'low',
      lastAcceptedAtMs: ACCEPTED_AT_MS,
    };
    const rows = resolveKwhPerUnitProvenanceRows({
      provenance,
      unitSuffix: 'kWh/°C',
      formatAcceptedAt,
    });
    expect(rows.map((row) => row.label)).toEqual(['Source', 'Samples', 'Last sample']);
  });

  it('omits the samples row when acceptedSamples is zero', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.5,
      acceptedSamples: 0,
      confidence: null,
      lastAcceptedAtMs: null,
    };
    expect(resolveKwhPerUnitProvenanceRows({
      provenance,
      unitSuffix: 'kWh/%',
      formatAcceptedAt,
    })).toEqual([
      { label: 'Source', value: 'Learned profile' },
      { label: 'Learned rate', value: '0.50 kWh/%' },
    ]);
  });

  it('uses singular wording when acceptedSamples is exactly one', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.5,
      acceptedSamples: 1,
      confidence: 'low',
      lastAcceptedAtMs: null,
    };
    const rows = resolveKwhPerUnitProvenanceRows({
      provenance,
      unitSuffix: 'kWh/%',
      formatAcceptedAt,
    });
    const samples = rows.find((row) => row.label === 'Samples');
    expect(samples?.value).toBe('1 accepted sample · low confidence');
  });

  it('omits confidence text from the samples row when confidence is null', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.5,
      acceptedSamples: 4,
      confidence: null,
      lastAcceptedAtMs: null,
    };
    const rows = resolveKwhPerUnitProvenanceRows({
      provenance,
      unitSuffix: 'kWh/%',
      formatAcceptedAt,
    });
    const samples = rows.find((row) => row.label === 'Samples');
    expect(samples?.value).toBe('4 accepted samples');
  });
});
