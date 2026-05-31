/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  STARVATION_RESCUE_WIDGET_COPY,
  formatStarvationOverflowCue,
  formatStarvationRowChip,
  resolveStarvationRescueRejectCopy,
  resolveStarvationRowNote,
  resolveStarvationRowSubtext,
  resolveStarvationRowTone,
  scheduledHoursIncludeCurrentHour,
  starvationDurationMinutes,
  starvationRowIsRescuable,
  starvationRowOffersRescue,
} from '../packages/shared-domain/src/planStarvation';

describe('starvation-rescue shared helpers', () => {
  describe('starvationDurationMinutes', () => {
    it('floors ms to whole minutes and never goes negative', () => {
      expect(starvationDurationMinutes(0)).toBe(0);
      expect(starvationDurationMinutes(59_999)).toBe(0);
      expect(starvationDurationMinutes(60_000)).toBe(1);
      expect(starvationDurationMinutes(150_000)).toBe(2);
      expect(starvationDurationMinutes(-5)).toBe(0);
      expect(starvationDurationMinutes(Number.NaN)).toBe(0);
    });
  });

  describe('formatStarvationRowChip', () => {
    it('says "Held back" only for the budget-releasable cause', () => {
      expect(formatStarvationRowChip('budget', 24 * 60_000)).toBe('Held back · 24 min');
    });
    it('says "Waiting" for physically-held causes (capacity, external)', () => {
      // The hard cap is not a tuning knob — a capacity row is never mislabeled
      // as the budget-releasable "Held back" state.
      expect(formatStarvationRowChip('capacity', 24 * 60_000)).toBe('Waiting · 24 min');
      expect(formatStarvationRowChip('external', 5 * 60_000)).toBe('Waiting · 5 min');
    });
    it('says "On hold" for the manual cause', () => {
      expect(formatStarvationRowChip('manual', 12 * 60_000)).toBe('On hold · 12 min');
    });
  });

  describe('resolveStarvationRowTone (escalates with duration)', () => {
    it('is warn below 30 minutes and danger at/above it', () => {
      expect(resolveStarvationRowTone(0)).toBe('warn');
      expect(resolveStarvationRowTone(29 * 60_000)).toBe('warn');
      expect(resolveStarvationRowTone(30 * 60_000)).toBe('danger');
      expect(resolveStarvationRowTone(120 * 60_000)).toBe('danger');
    });
  });

  describe('resolveStarvationRowSubtext', () => {
    it('maps each producer-resolved cause to plain language', () => {
      // Budget with no known target falls back to the plain budget line.
      expect(resolveStarvationRowSubtext('budget')).toBe('Held by today’s budget');
      // Capacity reuses the canonical overview wording.
      expect(resolveStarvationRowSubtext('capacity')).toBe('Waiting for available power');
      expect(resolveStarvationRowSubtext('manual')).toBe('Under manual control');
      expect(resolveStarvationRowSubtext('external')).toBe('Waiting on an external service');
    });

    it('names the held-below target on budget rows when known (felt symptom)', () => {
      expect(resolveStarvationRowSubtext('budget', 65)).toBe('Held below 65° by today’s budget');
      expect(resolveStarvationRowSubtext('budget', 21.5)).toBe('Held below 21.5° by today’s budget');
      // Non-finite / null target drops the felt-symptom clause.
      expect(resolveStarvationRowSubtext('budget', null)).toBe('Held by today’s budget');
      expect(resolveStarvationRowSubtext('budget', Number.NaN)).toBe('Held by today’s budget');
      // The target only personalises budget rows, never the other causes.
      expect(resolveStarvationRowSubtext('capacity', 21)).toBe('Waiting for available power');
    });
  });

  describe('formatStarvationOverflowCue', () => {
    it('returns null at or below the visible cap and "+N more" beyond it', () => {
      expect(formatStarvationOverflowCue(0)).toBeNull();
      expect(formatStarvationOverflowCue(2)).toBeNull();
      expect(formatStarvationOverflowCue(3)).toBe('+1 more');
      expect(formatStarvationOverflowCue(5)).toBe('+3 more');
      expect(formatStarvationOverflowCue(Number.NaN)).toBeNull();
    });
  });

  describe('resolveStarvationRowNote', () => {
    it('returns an informational note for non-budget causes only', () => {
      expect(resolveStarvationRowNote('budget')).toBeNull();
      expect(resolveStarvationRowNote('capacity')).toBe(STARVATION_RESCUE_WIDGET_COPY.capacityNote);
      expect(resolveStarvationRowNote('manual')).toBe(STARVATION_RESCUE_WIDGET_COPY.manualNote);
      expect(resolveStarvationRowNote('external')).toBe(STARVATION_RESCUE_WIDGET_COPY.externalNote);
    });

    it('never suggests raising the hard cap (capacity is physical)', () => {
      expect(STARVATION_RESCUE_WIDGET_COPY.capacityNote.toLowerCase()).not.toMatch(/cap|limit|raise|increase/);
    });
  });

  describe('starvationRowOffersRescue (budget-only guardrail)', () => {
    it('offers a rescue only for budget starvation', () => {
      expect(starvationRowOffersRescue('budget')).toBe(true);
      expect(starvationRowOffersRescue('capacity')).toBe(false);
      expect(starvationRowOffersRescue('manual')).toBe(false);
      expect(starvationRowOffersRescue('external')).toBe(false);
    });
  });

  describe('starvationRowIsRescuable (budget + known target)', () => {
    it('is rescuable only for a budget row with a finite target', () => {
      expect(starvationRowIsRescuable('budget', 65)).toBe(true);
      // Budget but no target — API would reject `no_target`, so the row is not rescuable.
      expect(starvationRowIsRescuable('budget', null)).toBe(false);
      expect(starvationRowIsRescuable('budget', Number.NaN)).toBe(false);
      // Non-budget causes are never rescuable regardless of target.
      expect(starvationRowIsRescuable('capacity', 21)).toBe(false);
      expect(starvationRowIsRescuable('manual', 21)).toBe(false);
      expect(starvationRowIsRescuable('external', 21)).toBe(false);
    });
  });

  describe('resolveStarvationRescueRejectCopy', () => {
    it('gives bespoke copy for deadline_passed and the generic line otherwise', () => {
      expect(resolveStarvationRescueRejectCopy('deadline_passed')).toBe(STARVATION_RESCUE_WIDGET_COPY.deadlinePassed);
      expect(resolveStarvationRescueRejectCopy('write_conflict')).toBe(STARVATION_RESCUE_WIDGET_COPY.rescueError);
      expect(resolveStarvationRescueRejectCopy(undefined)).toBe(STARVATION_RESCUE_WIDGET_COPY.rescueError);
    });
  });

  describe('scheduledHoursIncludeCurrentHour', () => {
    const HOUR = 60 * 60 * 1000;
    const nowMs = Date.UTC(2026, 0, 1, 4, 30, 0); // 04:30 — mid-hour, floors to 04:00

    it('is true when a scheduled hour matches the epoch-hour floor of now', () => {
      expect(scheduledHoursIncludeCurrentHour([{ startsAtMs: Date.UTC(2026, 0, 1, 4, 0, 0) }], nowMs)).toBe(true);
    });

    it('is false when the only scheduled hour is a later (cheaper) hour', () => {
      // The exact case the naive "has any scheduled hour" check got wrong.
      expect(scheduledHoursIncludeCurrentHour([{ startsAtMs: Date.UTC(2026, 0, 1, 7, 0, 0) }], nowMs)).toBe(false);
    });

    it('matches the current hour even when other future hours are also scheduled', () => {
      expect(scheduledHoursIncludeCurrentHour(
        [{ startsAtMs: Date.UTC(2026, 0, 1, 4, 0, 0) }, { startsAtMs: Date.UTC(2026, 0, 1, 6, 0, 0) }],
        nowMs,
      )).toBe(true);
    });

    it('is false for an empty schedule', () => {
      expect(scheduledHoursIncludeCurrentHour([], nowMs)).toBe(false);
    });

    it('ignores a past hour (a stale earlier bucket never counts as now)', () => {
      expect(scheduledHoursIncludeCurrentHour([{ startsAtMs: nowMs - HOUR }], nowMs)).toBe(false);
    });
  });
});
