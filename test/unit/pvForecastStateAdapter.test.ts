// Unit: normalizePvForecastState — pure persisted-blob validation at the settings
// boundary. Scope: the net-evidence fields added for zero-export clamp detection
// (importMs/exportMs/netMs, lastNetW) + legacy passthrough. The pre-existing
// field coercion (kwh/coveredMs/irradiance) is exercised incidentally.
import { describe, expect, it } from 'vitest';
import { normalizePvForecastState } from '../../setup/pvForecastStateAdapter';
import { classifyHourNetEvidence } from '../../packages/shared-domain/src/solar/pvGenerationHistory';

const HOUR_MS = 3_600_000;
const BASE = Date.UTC(2026, 5, 21, 10, 0, 0);
const KEY = String(BASE);

describe('normalizePvForecastState net-evidence fields', () => {
  it('passes a legacy blob through unchanged (no fabricated evidence fields)', () => {
    const legacy = {
      history: {
        lastSampleMs: BASE + HOUR_MS,
        lastGenerationW: 1200,
        hourly: { [KEY]: { kwh: 1.2, coveredMs: HOUR_MS } },
        taintedHourStarts: { [KEY]: true },
      },
      irradianceByHour: { [KEY]: 640 },
    };
    expect(normalizePvForecastState(legacy)).toEqual(legacy);
  });

  it('keeps valid evidence fields and the signed lastNetW anchor', () => {
    const state = {
      history: {
        lastSampleMs: BASE + HOUR_MS,
        lastGenerationW: 1200,
        lastNetW: -450, // export is NEGATIVE — must never be floored at 0
        hourly: {
          [KEY]: { kwh: 1.2, coveredMs: HOUR_MS, netMs: HOUR_MS, importMs: 0, exportMs: 600_000 },
        },
      },
      irradianceByHour: {},
    };
    expect(normalizePvForecastState(state)).toEqual(state);
  });

  it('omits each junk evidence field individually, keeping the hour itself', () => {
    const normalized = normalizePvForecastState({
      history: {
        hourly: {
          [KEY]: {
            kwh: 1.2,
            coveredMs: HOUR_MS,
            netMs: Number.NaN, // non-finite ⇒ omitted
            importMs: -5, // negative ⇒ omitted
            exportMs: HOUR_MS + 1, // > coveredMs ⇒ omitted
          },
        },
      },
    });
    // The hour survives with its energy; without netMs it classifies 'unknown'.
    expect(normalized?.history.hourly[KEY]).toEqual({ kwh: 1.2, coveredMs: HOUR_MS });
  });

  it('omits a wrong-shape evidence field without dropping its valid siblings', () => {
    const normalized = normalizePvForecastState({
      history: {
        hourly: {
          [KEY]: { kwh: 1.2, coveredMs: HOUR_MS, netMs: HOUR_MS, importMs: 'junk', exportMs: 0 },
        },
      },
    });
    expect(normalized?.history.hourly[KEY]).toEqual({ kwh: 1.2, coveredMs: HOUR_MS, netMs: HOUR_MS, exportMs: 0 });
  });

  it('bounds import/export sub-durations by netMs — a corrupt blob cannot classify unclamped', () => {
    // In-memory accrual can never put more import/export time in an hour than its
    // net-covered time. This blob claims importMs == coveredMs with netMs below it
    // — each field passes the coveredMs check alone, and unbounded it would
    // classify 'unclamped' (importMs >= 0.95 × netMs).
    const normalized = normalizePvForecastState({
      history: {
        hourly: {
          [KEY]: { kwh: 1.2, coveredMs: HOUR_MS, netMs: 0.95 * HOUR_MS, importMs: HOUR_MS, exportMs: HOUR_MS },
        },
      },
    });
    const bucket = normalized?.history.hourly[KEY];
    expect(bucket).toEqual({ kwh: 1.2, coveredMs: HOUR_MS, netMs: 0.95 * HOUR_MS });
    expect(classifyHourNetEvidence(bucket!)).toBe('suspect');
  });

  it('collapses the sub-duration bound to zero when netMs itself is invalid', () => {
    const normalized = normalizePvForecastState({
      history: {
        hourly: {
          [KEY]: { kwh: 1.2, coveredMs: HOUR_MS, netMs: -1, importMs: 600_000, exportMs: 0 },
        },
      },
    });
    // importMs > 0 has no net-covered time to sit inside ⇒ dropped; a literal 0 is harmless.
    expect(normalized?.history.hourly[KEY]).toEqual({ kwh: 1.2, coveredMs: HOUR_MS, exportMs: 0 });
  });

  it('drops a non-finite lastNetW instead of fabricating a value', () => {
    const normalized = normalizePvForecastState({
      history: { lastNetW: Number.POSITIVE_INFINITY, hourly: {} },
    });
    expect(normalized?.history.lastNetW).toBeUndefined();
  });

  it('strips unknown bucket fields (pins the rollback contract: older builds discard, never crash)', () => {
    // On rollback the OLD normalizer strips these evidence fields the same way —
    // accrued evidence is silently discarded and re-upgrade restarts from
    // 'unknown', but nothing breaks. This pins the strip semantics forward.
    const normalized = normalizePvForecastState({
      history: {
        hourly: { [KEY]: { kwh: 1.2, coveredMs: HOUR_MS, netMs: HOUR_MS, futureEvidenceMs: 123 } },
      },
    });
    expect(normalized?.history.hourly[KEY]).toEqual({ kwh: 1.2, coveredMs: HOUR_MS, netMs: HOUR_MS });
    expect(Object.keys(normalized?.history.hourly[KEY] ?? {})).not.toContain('futureEvidenceMs');
  });
});
