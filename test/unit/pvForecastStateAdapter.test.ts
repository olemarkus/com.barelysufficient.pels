// Unit: normalizePvForecastState — pure persisted-blob validation at the settings
// boundary. Scope: the net-evidence fields added for zero-export clamp detection
// (importMs/exportMs/netMs, lastNetW) + legacy passthrough. The pre-existing
// field coercion (kwh/coveredMs/irradiance) is exercised incidentally.
import { describe, expect, it } from 'vitest';
import { normalizePvForecastState } from '../../setup/pvForecastStateAdapter';
import type { PvForecastServiceState } from '../../lib/solar/pvForecastService';
import { classifyHourNetEvidence } from '../../packages/shared-domain/src/solar/pvGenerationHistory';

/** Unwrap a parse expected to be valid; a malformed parse fails the assertion. */
const parseValid = (raw: unknown): PvForecastServiceState => {
  const parsed = normalizePvForecastState(raw);
  if (parsed.kind !== 'valid') throw new Error(`expected a valid parse, got '${parsed.kind}'`);
  return parsed.state;
};

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
    expect(parseValid(legacy)).toEqual(legacy);
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
    expect(parseValid(state)).toEqual(state);
  });

  it('omits each junk evidence field individually, keeping the hour itself', () => {
    const normalized = parseValid({
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
    expect(normalized.history.hourly[KEY]).toEqual({ kwh: 1.2, coveredMs: HOUR_MS });
  });

  it('omits a wrong-shape evidence field without dropping its valid siblings', () => {
    const normalized = parseValid({
      history: {
        hourly: {
          [KEY]: { kwh: 1.2, coveredMs: HOUR_MS, netMs: HOUR_MS, importMs: 'junk', exportMs: 0 },
        },
      },
    });
    expect(normalized.history.hourly[KEY]).toEqual({ kwh: 1.2, coveredMs: HOUR_MS, netMs: HOUR_MS, exportMs: 0 });
  });

  it('bounds import/export sub-durations by netMs — a corrupt blob cannot classify unclamped', () => {
    // In-memory accrual can never put more import/export time in an hour than its
    // net-covered time. This blob claims importMs == coveredMs with netMs below it
    // — each field passes the coveredMs check alone, and unbounded it would
    // classify 'unclamped' (importMs >= 0.95 × netMs).
    const normalized = parseValid({
      history: {
        hourly: {
          [KEY]: { kwh: 1.2, coveredMs: HOUR_MS, netMs: 0.95 * HOUR_MS, importMs: HOUR_MS, exportMs: HOUR_MS },
        },
      },
    });
    const bucket = normalized.history.hourly[KEY];
    expect(bucket).toEqual({ kwh: 1.2, coveredMs: HOUR_MS, netMs: 0.95 * HOUR_MS });
    expect(classifyHourNetEvidence(bucket!)).toBe('suspect');
  });

  it('drops an hour whose coveredMs exceeds a physical hour (corrupt oversized blob)', () => {
    // A blob with an oversized coveredMs — and net/import durations sized to match
    // it — would otherwise survive normalization and forge `unclamped` evidence to
    // train the PV gain. The boundary rejects the physically-impossible hour while
    // keeping its valid sibling (a companion hour, so the per-hour drop is pinned
    // independently of the every-claimed-hour-dropped ⇒ malformed rule).
    const KEY2 = String(BASE + HOUR_MS);
    const normalized = parseValid({
      history: {
        hourly: {
          [KEY]: { kwh: 5, coveredMs: 10 * HOUR_MS, netMs: 10 * HOUR_MS, importMs: 10 * HOUR_MS },
          [KEY2]: { kwh: 0.4, coveredMs: HOUR_MS },
        },
      },
    });
    expect(normalized.history.hourly[KEY]).toBeUndefined();
    expect(normalized.history.hourly[KEY2]).toEqual({ kwh: 0.4, coveredMs: HOUR_MS });
  });

  it('drops an hour whose coveredMs is negative', () => {
    // A negative coveredMs is physically impossible and would give the sub-duration
    // bound a nonsensical ceiling; the boundary rejects the whole hour (companion
    // hour as above).
    const KEY2 = String(BASE + HOUR_MS);
    const normalized = parseValid({
      history: {
        hourly: {
          [KEY]: { kwh: 1.2, coveredMs: -1, netMs: 0 },
          [KEY2]: { kwh: 0.4, coveredMs: HOUR_MS },
        },
      },
    });
    expect(normalized.history.hourly[KEY]).toBeUndefined();
    expect(normalized.history.hourly[KEY2]).toEqual({ kwh: 0.4, coveredMs: HOUR_MS });
  });

  it('collapses the sub-duration bound to zero when netMs itself is invalid', () => {
    const normalized = parseValid({
      history: {
        hourly: {
          [KEY]: { kwh: 1.2, coveredMs: HOUR_MS, netMs: -1, importMs: 600_000, exportMs: 0 },
        },
      },
    });
    // importMs > 0 has no net-covered time to sit inside ⇒ dropped; a literal 0 is harmless.
    expect(normalized.history.hourly[KEY]).toEqual({ kwh: 1.2, coveredMs: HOUR_MS, exportMs: 0 });
  });

  it('drops a non-finite lastNetW instead of fabricating a value', () => {
    const normalized = parseValid({
      history: { lastNetW: Number.POSITIVE_INFINITY, hourly: {} },
    });
    expect(normalized.history.lastNetW).toBeUndefined();
  });

  it('strips unknown bucket fields (pins the rollback contract: older builds discard, never crash)', () => {
    // On rollback the OLD normalizer strips these evidence fields the same way —
    // accrued evidence is silently discarded and re-upgrade restarts from
    // 'unknown', but nothing breaks. This pins the strip semantics forward.
    const normalized = parseValid({
      history: {
        hourly: { [KEY]: { kwh: 1.2, coveredMs: HOUR_MS, netMs: HOUR_MS, futureEvidenceMs: 123 } },
      },
    });
    expect(normalized.history.hourly[KEY]).toEqual({ kwh: 1.2, coveredMs: HOUR_MS, netMs: HOUR_MS });
    expect(Object.keys(normalized.history.hourly[KEY] ?? {})).not.toContain('futureEvidenceMs');
  });

  it('classifies a non-record blob as malformed (never an empty state)', () => {
    // Malformed means the blob cannot vouch for any history AT ALL — the boot
    // read stays suspect instead of starting the service empty and letting the
    // persist timer overwrite recorded history.
    expect(normalizePvForecastState('junk')).toEqual({ kind: 'malformed' });
    expect(normalizePvForecastState(undefined)).toEqual({ kind: 'malformed' });
  });

  it('classifies a blob whose history is not a record as malformed', () => {
    expect(normalizePvForecastState({ history: 'junk', irradianceByHour: {} })).toEqual({ kind: 'malformed' });
  });

  it('classifies a history without an hourly record as malformed (no writer produces one)', () => {
    expect(normalizePvForecastState({ history: {}, irradianceByHour: {} })).toEqual({ kind: 'malformed' });
    expect(normalizePvForecastState({ history: { hourly: 'junk' } })).toEqual({ kind: 'malformed' });
  });

  it('classifies a blob whose EVERY claimed hour fails coercion as malformed, not empty', () => {
    // Partial corruption must stay suspect: parsing this to an empty-but-valid
    // state would let the next persist overwrite a possibly-recoverable blob.
    expect(normalizePvForecastState({
      history: { hourly: { [KEY]: { kwh: 'junk', coveredMs: HOUR_MS } } },
    })).toEqual({ kind: 'malformed' });
  });

  it('classifies array-shaped payloads as malformed — arrays are not records', () => {
    // `typeof [] === 'object'`: an array-shaped hourly (numeric indices pass
    // the hour-key check) or blob must not pass plausibility as a valid empty
    // state and let the first dirty persist overwrite a suspect blob.
    expect(normalizePvForecastState({ history: { hourly: [] } })).toEqual({ kind: 'malformed' });
    expect(normalizePvForecastState({
      history: { hourly: [{ kwh: 1.2, coveredMs: HOUR_MS }] },
    })).toEqual({ kind: 'malformed' });
    expect(normalizePvForecastState([])).toEqual({ kind: 'malformed' });
    expect(normalizePvForecastState({ history: [] })).toEqual({ kind: 'malformed' });
  });

  it('keeps a genuinely empty hourly record valid — the persisted empty state is real', () => {
    const empty = { history: { hourly: {} }, irradianceByHour: {} };
    expect(parseValid(empty)).toEqual(empty);
  });
});
