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
const ONE_MIN_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MIN_MS;

describe('resolveKwhPerUnitProvenanceRows', () => {
  it('returns an empty list when provenance is absent', () => {
    expect(resolveKwhPerUnitProvenanceRows({
      provenance: undefined,
      nowMs: ACCEPTED_AT_MS,
      formatAcceptedAt,
    })).toEqual([]);
  });

  it('renders a single "Starting estimate" source row for bootstrap provenance', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'bootstrap',
      kWhPerUnit: null,
      acceptedSamples: 0,
      confidence: null,
      lastAcceptedAtMs: null,
    };
    expect(resolveKwhPerUnitProvenanceRows({
      provenance,
      nowMs: ACCEPTED_AT_MS,
      formatAcceptedAt,
    })).toEqual([{ label: 'Source', value: 'Starting estimate', tone: null }]);
  });

  it('renders source/samples/last-sample rows for fully-populated learned provenance — no duplicate "Learned rate" row', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.42,
      acceptedSamples: 12,
      confidence: 'medium',
      lastAcceptedAtMs: ACCEPTED_AT_MS,
    };
    expect(resolveKwhPerUnitProvenanceRows({
      provenance,
      nowMs: ACCEPTED_AT_MS + 5 * ONE_MIN_MS,
      formatAcceptedAt,
    })).toEqual([
      { label: 'Source', value: 'Learned from power readings', tone: null },
      { label: 'Readings used', value: '12 accepted power readings · medium confidence', tone: null },
      // `freshnessOfMs` mirrors `lastAcceptedAtMs` so the React view can
      // re-derive the relative-time string (and `tone`) on its 60s tick.
      // Non-React consumers (runtime breadcrumbs) ignore the field and read
      // `value`/`tone` directly.
      {
        label: 'Latest reading used',
        value: 'Updated 5 min ago',
        tone: null,
        freshnessOfMs: ACCEPTED_AT_MS,
      },
    ]);
  });

  it('emits "Updated just now" when the most recent sample is fresher than one minute', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.5,
      acceptedSamples: 3,
      confidence: 'low',
      lastAcceptedAtMs: ACCEPTED_AT_MS,
    };
    const rows = resolveKwhPerUnitProvenanceRows({
      provenance,
      nowMs: ACCEPTED_AT_MS + 15 * 1000,
      formatAcceptedAt,
    });
    expect(rows.find((row) => row.label === 'Latest reading used')?.value).toBe('Updated just now');
  });

  it('emits hour-resolution copy past the one-hour boundary', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.5,
      acceptedSamples: 3,
      confidence: 'low',
      lastAcceptedAtMs: ACCEPTED_AT_MS,
    };
    const rows = resolveKwhPerUnitProvenanceRows({
      provenance,
      nowMs: ACCEPTED_AT_MS + 3 * ONE_HOUR_MS,
      formatAcceptedAt,
    });
    expect(rows.find((row) => row.label === 'Latest reading used')?.value).toBe('Updated 3 hours ago');
  });

  it('marks the row as stale and surfaces the absolute timestamp past 24h', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.5,
      acceptedSamples: 4,
      confidence: 'medium',
      lastAcceptedAtMs: ACCEPTED_AT_MS,
    };
    const rows = resolveKwhPerUnitProvenanceRows({
      provenance,
      nowMs: ACCEPTED_AT_MS + 48 * ONE_HOUR_MS,
      formatAcceptedAt,
    });
    expect(rows.find((row) => row.label === 'Latest reading used')?.value).toBe(`Stale — ${STUB_ACCEPTED_AT}`);
  });

  // Pin the producer's `tone` contract on the latest-sample row across the
  // freshness boundary. The view layer reads this flat slug and maps it to a
  // CSS modifier (`.plan-inputs__row-value--warn`); asserting the slug here
  // — not the class name — keeps the test stable across a CSS rename and
  // catches regressions where the consumer might re-derive staleness from
  // the value text (forbidden by `feedback_layering_resolution_in_producer`).
  it('emits a warn tone on the latest-sample row past the 24 h freshness window', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.5,
      acceptedSamples: 4,
      confidence: 'medium',
      lastAcceptedAtMs: ACCEPTED_AT_MS,
    };
    const rows = resolveKwhPerUnitProvenanceRows({
      provenance,
      nowMs: ACCEPTED_AT_MS + 48 * ONE_HOUR_MS,
      formatAcceptedAt,
    });
    const latest = rows.find((row) => row.label === 'Latest reading used');
    expect(latest?.tone).toBe('warn');
    // Sibling rows stay neutral — only the stale branch carries a tone.
    expect(rows.find((row) => row.label === 'Source')?.tone).toBeNull();
    expect(rows.find((row) => row.label === 'Readings used')?.tone).toBeNull();
  });

  it('leaves the latest-sample tone null when the sample sits inside the freshness window', () => {
    const provenance: DeferredObjectiveKwhPerUnitProvenanceV1 = {
      source: 'learned',
      kWhPerUnit: 0.5,
      acceptedSamples: 4,
      confidence: 'medium',
      lastAcceptedAtMs: ACCEPTED_AT_MS,
    };
    const rows = resolveKwhPerUnitProvenanceRows({
      provenance,
      // Sit one minute short of the 24 h stale threshold — well inside fresh.
      nowMs: ACCEPTED_AT_MS + 24 * ONE_HOUR_MS - ONE_MIN_MS,
      formatAcceptedAt,
    });
    const latest = rows.find((row) => row.label === 'Latest reading used');
    expect(latest?.tone).toBeNull();
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
      nowMs: ACCEPTED_AT_MS,
      formatAcceptedAt,
    })).toEqual([
      { label: 'Source', value: 'Learned from power readings', tone: null },
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
      nowMs: ACCEPTED_AT_MS,
      formatAcceptedAt,
    });
    const samples = rows.find((row) => row.label === 'Readings used');
    expect(samples?.value).toBe('1 accepted power reading · low confidence');
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
      nowMs: ACCEPTED_AT_MS,
      formatAcceptedAt,
    });
    const samples = rows.find((row) => row.label === 'Readings used');
    expect(samples?.value).toBe('4 accepted power readings');
  });
});
