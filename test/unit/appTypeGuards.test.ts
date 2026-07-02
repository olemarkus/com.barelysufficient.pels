import {
  isBooleanMap,
  isCommunicationModelMap,
  isFiniteNumber,
  isNumberMap,
  isPowerTrackerState,
  isPrioritySettings,
  isStringMap,
  sanitizePowerTrackerSolarFields,
} from '../../lib/utils/appTypeGuards';

describe('appTypeGuards plain-object handling', () => {
  describe('isStringMap', () => {
    it('accepts a plain object of string entries', () => {
      expect(isStringMap({ a: '1', b: '2' })).toBe(true);
      expect(isStringMap({})).toBe(true);
    });

    it('rejects arrays, class instances, and non-string entries', () => {
      expect(isStringMap(['a', 'b'])).toBe(false);
      expect(isStringMap(new Date())).toBe(false);
      expect(isStringMap({ a: 1 })).toBe(false);
    });
  });

  describe('isBooleanMap', () => {
    it('accepts a plain object of boolean entries', () => {
      expect(isBooleanMap({ a: true, b: false })).toBe(true);
    });

    it('rejects arrays and non-boolean entries', () => {
      expect(isBooleanMap([true, false])).toBe(false);
      expect(isBooleanMap({ a: 'true' })).toBe(false);
    });
  });

  describe('isNumberMap', () => {
    it('accepts finite-number entries', () => {
      expect(isNumberMap({ a: 1.5, b: 2 })).toBe(true);
    });

    it('rejects non-finite numbers and non-numeric entries', () => {
      expect(isNumberMap({ a: Number.NaN })).toBe(false);
      expect(isNumberMap({ a: '1' })).toBe(false);
    });
  });

  describe('isCommunicationModelMap', () => {
    it('accepts a mix of local/cloud entries', () => {
      expect(isCommunicationModelMap({ a: 'local', b: 'cloud' })).toBe(true);
    });

    it('rejects other strings', () => {
      expect(isCommunicationModelMap({ a: 'wifi' })).toBe(false);
    });
  });

  describe('isPrioritySettings', () => {
    it('accepts a nested record of numeric priorities', () => {
      expect(isPrioritySettings({ Home: { dev: 1 }, Away: { dev: 2 } })).toBe(true);
    });

    it('rejects arrays nested inside the value', () => {
      expect(isPrioritySettings({ Home: ['dev'] })).toBe(false);
    });

    it('rejects non-numeric leaf values', () => {
      expect(isPrioritySettings({ Home: { dev: 'high' } })).toBe(false);
    });
  });

  describe('isFiniteNumber', () => {
    it('matches finite numbers only', () => {
      expect(isFiniteNumber(1)).toBe(true);
      expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
      expect(isFiniteNumber('1')).toBe(false);
    });
  });

  describe('isPowerTrackerState — solar family shapes', () => {
    it('accepts a state carrying the solar bucket families and generation latch', () => {
      expect(isPowerTrackerState({
        buckets: { '2026-06-01T10:00:00.000Z': 0.5 },
        generationBuckets: { '2026-06-01T10:00:00.000Z': 2.4 },
        exportBuckets: { '2026-06-01T10:00:00.000Z': 0.8 },
        generationDailyTotals: { '2026-05-01': 12 },
        exportDailyTotals: { '2026-05-01': 3 },
        lastGenerationW: 3200,
      })).toBe(true);
    });

    it('accepts a state with all solar fields absent (non-solar home)', () => {
      expect(isPowerTrackerState({ buckets: {} })).toBe(true);
    });

    it('rejects non-record solar families and a non-numeric generation latch', () => {
      expect(isPowerTrackerState({ generationBuckets: 'junk' })).toBe(false);
      expect(isPowerTrackerState({ exportBuckets: 4 })).toBe(false);
      expect(isPowerTrackerState({ generationDailyTotals: true })).toBe(false);
      expect(isPowerTrackerState({ exportDailyTotals: 'x' })).toBe(false);
      expect(isPowerTrackerState({ lastGenerationW: 'high' })).toBe(false);
    });
  });

  describe('sanitizePowerTrackerSolarFields', () => {
    it('drops a junk solar field but keeps the billed history (destroy-nothing invariant)', () => {
      const blob = {
        buckets: { '2026-06-01T10:00:00.000Z': 0.5 },
        dailyTotals: { '2026-05-01': 12 },
        generationBuckets: 'x',
        exportBuckets: { '2026-06-01T10:00:00.000Z': 0.8 },
        lastGenerationW: 'high',
      };
      const sanitized = sanitizePowerTrackerSolarFields(blob) as Record<string, unknown>;
      // The junk solar fields are gone…
      expect('generationBuckets' in sanitized).toBe(false);
      expect('lastGenerationW' in sanitized).toBe(false);
      // …the healthy ones (solar and billed) survive…
      expect(sanitized.buckets).toEqual({ '2026-06-01T10:00:00.000Z': 0.5 });
      expect(sanitized.dailyTotals).toEqual({ '2026-05-01': 12 });
      expect(sanitized.exportBuckets).toEqual({ '2026-06-01T10:00:00.000Z': 0.8 });
      // …and the sanitized blob now passes the guard instead of losing the
      // whole tracker to an all-or-nothing reject.
      expect(isPowerTrackerState(sanitized)).toBe(true);
    });

    it('returns clean and non-object inputs untouched (same reference)', () => {
      const clean = { buckets: {}, generationBuckets: { a: 1 } };
      expect(sanitizePowerTrackerSolarFields(clean)).toBe(clean);
      expect(sanitizePowerTrackerSolarFields(null)).toBeNull();
      expect(sanitizePowerTrackerSolarFields('junk')).toBe('junk');
    });

    it('drops junk KEYS inside a record but keeps the healthy hours around them', () => {
      // A single poisoned hour must not cost the record — and must never
      // reach the prune fold, where `Math.max(0, 'oops')` NaN-poisons the
      // whole local-day total.
      const sanitized = sanitizePowerTrackerSolarFields({
        generationBuckets: {
          '2026-06-01T10:00:00.000Z': 2.4,
          '2026-06-01T11:00:00.000Z': 'oops',
          '2026-06-01T12:00:00.000Z': Number.NaN,
          '2026-06-01T13:00:00.000Z': -1,
          '2026-06-01T14:00:00.000Z': 0,
        },
      }) as Record<string, unknown>;
      expect(sanitized.generationBuckets).toEqual({
        '2026-06-01T10:00:00.000Z': 2.4,
        '2026-06-01T14:00:00.000Z': 0,
      });
    });

    it('treats arrays and non-plain objects as junk fields', () => {
      const sanitized = sanitizePowerTrackerSolarFields({
        buckets: { '2026-06-01T10:00:00.000Z': 0.5 },
        generationBuckets: [1, 2],
        exportBuckets: new Date(),
        exportDailyTotals: { '2026-05-01': 3 },
      }) as Record<string, unknown>;
      expect('generationBuckets' in sanitized).toBe(false);
      expect('exportBuckets' in sanitized).toBe(false);
      expect(sanitized.exportDailyTotals).toEqual({ '2026-05-01': 3 });
      expect(sanitized.buckets).toEqual({ '2026-06-01T10:00:00.000Z': 0.5 });
    });

    it('drops a non-finite or negative generation latch', () => {
      for (const junkLatch of [Number.NaN, Number.POSITIVE_INFINITY, -500, 'high']) {
        const sanitized = sanitizePowerTrackerSolarFields({
          buckets: {},
          lastGenerationW: junkLatch,
        }) as Record<string, unknown>;
        expect('lastGenerationW' in sanitized).toBe(false);
      }
      const clean = { buckets: {}, lastGenerationW: 0 };
      expect(sanitizePowerTrackerSolarFields(clean)).toBe(clean);
    });
  });
});
