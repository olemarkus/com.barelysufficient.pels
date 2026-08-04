/**
 * @vitest-environment node
 */
import {
  BUDGET_EXEMPT_CARD_ACTION_COPY,
  STARVATION_RESCUE_WIDGET_COPY,
  budgetExemptCardActionAriaLabel,
  formatStarvationDurationLabel,
  formatStarvationOverflowCue,
  formatStarvationRowChip,
  resolveStarvationRescueRejectCopy,
  resolveStarvationRowNote,
  resolveStarvationRowSubtext,
  resolveStarvationRowTone,
  scheduledHoursIncludeCurrentHour,
  shouldOfferBudgetExemptCardAction,
  starvationDurationMinutes,
  starvationRowIsRescuable,
} from '../../packages/shared-domain/src/planStarvation';
import type { SettingsUiPlanDeviceStarvation } from '../../packages/contracts/src/settingsUiApi';

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

  // NBSP-joined so a duration is one unbreakable token at 320 px.
  const NBSP = '\u00a0';

  describe('formatStarvationDurationLabel', () => {
    it('rolls over into hours instead of unbounded minutes', () => {
      // The pre-2026-08-04 minutes-only chip rendered a 2.6-hour hold as
      // "156 min" — the exact case the overview card now shows on every long
      // hold, which is why the rollover had to exist before the card used it.
      expect(formatStarvationDurationLabel(156 * 60_000)).toBe(`2${NBSP}h${NBSP}36${NBSP}min`);
      expect(formatStarvationDurationLabel(0)).toBe(`0${NBSP}min`);
      expect(formatStarvationDurationLabel(45 * 60_000)).toBe(`45${NBSP}min`);
      expect(formatStarvationDurationLabel(60 * 60_000)).toBe(`1${NBSP}h`);
      expect(formatStarvationDurationLabel(120 * 60_000)).toBe(`2${NBSP}h`);
      expect(formatStarvationDurationLabel(135 * 60_000)).toBe(`2${NBSP}h${NBSP}15${NBSP}min`);
    });

    it('inherits the no-seconds contract and the non-negative floor', () => {
      expect(formatStarvationDurationLabel(59_999)).toBe(`0${NBSP}min`);
      expect(formatStarvationDurationLabel(-5)).toBe(`0${NBSP}min`);
      expect(formatStarvationDurationLabel(Number.NaN)).toBe(`0${NBSP}min`);
    });
  });

  describe('formatStarvationRowChip', () => {
    // One chip word for every held-back row: which constraint binds is not a
    // property of the device, and the bucket that used to split this flipped
    // mid-hold.
    it('says "Held back" with the rolled-over duration', () => {
      expect(formatStarvationRowChip(24 * 60_000)).toBe(`Held back · 24${NBSP}min`);
      expect(formatStarvationRowChip(135 * 60_000)).toBe(`Held back · 2${NBSP}h${NBSP}15${NBSP}min`);
    });

    // The hour boundary, where the rollover either fires or does not.
    it('crosses the hour boundary exactly once', () => {
      expect(formatStarvationRowChip(59 * 60_000)).toBe(`Held back · 59${NBSP}min`);
      expect(formatStarvationRowChip(60 * 60_000)).toBe(`Held back · 1${NBSP}h`);
      expect(formatStarvationRowChip(61 * 60_000)).toBe(`Held back · 1${NBSP}h${NBSP}1${NBSP}min`);
    });

    // "Held back · 0 min" reads as a stuck counter, so a duration that rounds to
    // nothing drops the suffix instead. Unreachable on a real row (the 15-minute
    // entry latency guarantees a positive duration) — this is the boundary.
    it('drops the duration suffix rather than printing a zero', () => {
      expect(formatStarvationRowChip(0)).toBe('Held back');
      expect(formatStarvationRowChip(30_000)).toBe('Held back');
      expect(formatStarvationRowChip(-1)).toBe('Held back');
      expect(formatStarvationRowChip(Number.NaN)).toBe('Held back');
      expect(formatStarvationRowChip(Number.POSITIVE_INFINITY)).toBe('Held back');
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
    it('names the held-below target when known (the felt symptom)', () => {
      expect(resolveStarvationRowSubtext(65)).toBe('Held below 65 °C');
      expect(resolveStarvationRowSubtext(21.5)).toBe('Held below 21.5 °C');
    });

    it('falls back to the canonical wording when there is no target to name', () => {
      expect(resolveStarvationRowSubtext()).toBe('Waiting for available power');
      expect(resolveStarvationRowSubtext(null)).toBe('Waiting for available power');
      expect(resolveStarvationRowSubtext(Number.NaN)).toBe('Waiting for available power');
    });

    it('names no ceiling — that is the hero\'s one job', () => {
      // Which limit binds moves on its own; the row states the device's symptom.
      expect(resolveStarvationRowSubtext(65).toLowerCase()).not.toMatch(/budget|cap|limit/);
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
    it('explains a row that has no rescue button because the device has its own task', () => {
      // A plain row gets no note (it has a rescue button); a row whose device
      // already has a smart task gets the explanatory smart-task note. This is
      // the only note left — the capacity note went with the cause bucket, and
      // it had only ever restated the row subtext.
      expect(resolveStarvationRowNote(true)).toBe(STARVATION_RESCUE_WIDGET_COPY.smartTaskNote);
      expect(resolveStarvationRowNote(true, 65)).toBe(STARVATION_RESCUE_WIDGET_COPY.smartTaskNote);
    });

    // The widget is a standalone dashboard surface — no hero sits near it to
    // state the house-level fact once, so a row whose subtext is only its felt
    // symptom would never say why the device is held.
    it('carries the canonical why on a row whose subtext names a target', () => {
      expect(resolveStarvationRowNote(false, 65)).toBe('Waiting for available power');
    });

    it('suppresses it when the subtext already IS that sentence', () => {
      expect(resolveStarvationRowNote()).toBeNull();
      expect(resolveStarvationRowNote(false)).toBeNull();
      expect(resolveStarvationRowNote(false, null)).toBeNull();
      expect(resolveStarvationRowSubtext(null)).toBe('Waiting for available power');
    });
  });

  describe('starvationRowIsRescuable (known target, task-free, main home)', () => {
    it('is rescuable with a finite target', () => {
      expect(starvationRowIsRescuable(65)).toBe(true);
      // No target — the API would reject `no_target`, so the row is not rescuable.
      expect(starvationRowIsRescuable(null)).toBe(false);
      expect(starvationRowIsRescuable(Number.NaN)).toBe(false);
    });

    it('is NOT rescuable when the device already has its own smart task', () => {
      // Shown in the list but button-suppressed — its existing task handles it.
      expect(starvationRowIsRescuable(65, true)).toBe(false);
      expect(starvationRowIsRescuable(65, false)).toBe(true);
    });

    it('is NOT rescuable outside the main home (smart tasks are main-home only)', () => {
      expect(starvationRowIsRescuable(65, false, 'unavailable')).toBe(false);
      expect(starvationRowIsRescuable(65, false, 'main')).toBe(true);
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

  describe('budget-exempt overview-card affordance', () => {
    const starvation = (
      overrides: Partial<SettingsUiPlanDeviceStarvation> = {},
    ): SettingsUiPlanDeviceStarvation => ({
      isStarved: true,
      accumulatedMs: 5 * 60_000,
      startedAtMs: 0,
      ...overrides,
    });

    describe('shouldOfferBudgetExemptCardAction', () => {
      // Held back is the whole gate. A standing budget exemption used to suppress
      // it too, on the reasoning that an exempt device cannot be budget-held — but
      // a hold can be capacity-bound, so it can be held back anyway, and the
      // rescue still helps by clearing room from lower-priority load. The
      // exemption no longer reaches this predicate at all, so the regression guard
      // for that lives where it can still fail: `budgetExemptChip.test.ts` renders
      // the real chip with `budgetExempt: true`.
      it('offers the affordance for a held-back device', () => {
        expect(shouldOfferBudgetExemptCardAction(starvation())).toBe(true);
      });

      it('does not offer it when the device is not held back at all', () => {
        expect(shouldOfferBudgetExemptCardAction(starvation({ isStarved: false }))).toBe(false);
        expect(shouldOfferBudgetExemptCardAction(null)).toBe(false);
        expect(shouldOfferBudgetExemptCardAction(undefined)).toBe(false);
      });

      // The gate reads `isStarved` and nothing else — no duration threshold, and
      // (since 2026-08-04) no constraint bucket and no exemption term. The
      // end-to-end proof that a capacity-attributed device now reaches the
      // affordance lives at the producer, in `deviceDiagnosticsService.test.ts`
      // ('lists currently-starved devices …'), which feeds one `capacity` and
      // one `daily_budget` device through the real service and gets two
      // identical rescue entries.
      it('offers the affordance the moment a device is held back, at any duration', () => {
        expect(shouldOfferBudgetExemptCardAction(starvation({ accumulatedMs: 0 }))).toBe(true);
        expect(shouldOfferBudgetExemptCardAction(starvation({ accumulatedMs: 3 * 60 * 60_000 }))).toBe(true);
      });
    });

    describe('copy + aria', () => {
      it('reuses the held-back widget rescue verb so the two surfaces speak one language', () => {
        // The bounded rescue, not the standing exempt toggle — the chip uses the
        // SAME "Let it run now" verb the held-back widget's rescue button uses.
        expect(BUDGET_EXEMPT_CARD_ACTION_COPY.label).toBe('Let it run now');
        expect(BUDGET_EXEMPT_CARD_ACTION_COPY.label).toBe(STARVATION_RESCUE_WIDGET_COPY.rescueButton);
        // The armed-confirm verb reuses the widget's confirm word.
        expect(BUDGET_EXEMPT_CARD_ACTION_COPY.confirmLabel).toBe(STARVATION_RESCUE_WIDGET_COPY.rescueConfirmButton);
      });

      it('names the money-action consequence without suggesting the hard cap be raised', () => {
        // The tooltip is the canonical rescue consequence shared with the widget.
        expect(BUDGET_EXEMPT_CARD_ACTION_COPY.tooltip).toBe(STARVATION_RESCUE_WIDGET_COPY.rescueConsequence);
        expect(BUDGET_EXEMPT_CARD_ACTION_COPY.tooltip).toContain('budget');
        expect(BUDGET_EXEMPT_CARD_ACTION_COPY.tooltip.toLowerCase()).not.toContain('hard cap');
        expect(BUDGET_EXEMPT_CARD_ACTION_COPY.tooltip.toLowerCase()).not.toContain('raise');
      });

      it('names the device in the aria-label (rescue phrasing), with a generic fallback', () => {
        expect(budgetExemptCardActionAriaLabel('Termostat Synne')).toBe('Let Termostat Synne run now');
        expect(budgetExemptCardActionAriaLabel('')).toBe('Let this device run now');
      });
    });
  });
});
