// Unit coverage for the "Paused — not managed" presentation plumbing: the
// status/copy resolvers must surface the pause on every smart-task surface
// (list chip, pending hero, widget detail, preview) rather than letting a
// cached revision keep claiming the task is on track.
import { describe, expect, it } from 'vitest';
import {
  deadlineLabels,
  resolvePausedUnmanagedChipTone,
  resolveSmartTaskListStatus,
  resolveSmartTaskWidgetDetailCopy,
  SMART_TASK_DEVICE_UNMANAGED_RECOURSE,
  SMART_TASK_DEVICE_UNMANAGED_WHY,
  SMART_TASK_LIST_STATUS_CHIP_VARIANT,
  SMART_TASK_LIST_STATUS_LABELS,
  SMART_TASK_WIDGET_STATUS_LABELS,
} from '../../packages/shared-domain/src/deadlineLabels';
import { resolveDeadlinesListHero } from '../../packages/shared-domain/src/deadlinesListHero';

describe('un-managed device: list status', () => {
  it('overrides a cached on-track revision with the paused status', () => {
    expect(resolveSmartTaskListStatus({
      pending: false,
      pendingReason: undefined,
      diagnosticReasonCode: 'objective_device_unmanaged',
      planStatus: 'on_track',
      firstActionAtMs: 1,
      nowMs: 0,
    })).toBe('paused_unmanaged');
  });

  it('maps a never-revised paused task to the pause, not "Building plan…"', () => {
    expect(resolveSmartTaskListStatus({
      pending: true,
      pendingReason: 'device_unmanaged',
      diagnosticReasonCode: undefined,
      planStatus: undefined,
      firstActionAtMs: null,
      nowMs: 0,
    })).toBe('paused_unmanaged');
  });
});

describe('un-managed device: copy', () => {
  it('labels the chip as a pause and names the real toggle in the recourse', () => {
    expect(SMART_TASK_LIST_STATUS_LABELS.paused_unmanaged).toBe('Paused — not managed');
    expect(SMART_TASK_WIDGET_STATUS_LABELS.paused_unmanaged).toBe('Not managed');
    expect(SMART_TASK_DEVICE_UNMANAGED_RECOURSE).toContain('Managed by PELS');
  });

  it('warns without alarming — the task is unharmed until the owner acts', () => {
    expect(resolvePausedUnmanagedChipTone()).toBe('warn');
    expect(SMART_TASK_LIST_STATUS_CHIP_VARIANT.paused_unmanaged).toBe('warn');
  });

  it('gives the widget detail panel both the cause and the way out (pending path)', () => {
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'building_plan',
      pendingReason: 'device_unmanaged',
      firstPlannedTimeLabel: null,
    })).toEqual({
      whyLabel: SMART_TASK_DEVICE_UNMANAGED_WHY,
      recourseHint: SMART_TASK_DEVICE_UNMANAGED_RECOURSE,
    });
  });

  it('gives the same way out on the status path a live diagnostic actually takes', () => {
    // A live `objective_device_unmanaged` resolves straight to the status id,
    // so the pending branch above never runs for it. A pause that names no way
    // out is the one thing this state must not be.
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'paused_unmanaged',
      firstPlannedTimeLabel: null,
    })).toEqual({
      whyLabel: SMART_TASK_DEVICE_UNMANAGED_WHY,
      recourseHint: SMART_TASK_DEVICE_UNMANAGED_RECOURSE,
    });
  });

  it('spends the pending hero’s four slots on four distinct facts', () => {
    const hero = deadlineLabels('temperature').pendingHeroByReason.device_unmanaged({
      priceSource: 'managed',
      lastFetchedShort: null,
      deviceId: 'heater-1',
      deviceName: 'Bathroom heater',
      deadlineTime: '06:30',
    });
    // The chip above already says "Paused — not managed"; the headline must not
    // repeat it, and the body must not repeat the reason line.
    expect(hero.headline).not.toBe(SMART_TASK_LIST_STATUS_LABELS.paused_unmanaged);
    expect(hero.headlineReason).toBe(SMART_TASK_DEVICE_UNMANAGED_WHY);
    expect(hero.body).toBe(SMART_TASK_DEVICE_UNMANAGED_RECOURSE);
    expect(hero.recourse).toMatchObject({ deviceId: 'heater-1' });
  });
});

describe('un-managed device: smart-tasks list hero', () => {
  it('counts the card as paused rather than on track', () => {
    const hero = resolveDeadlinesListHero({
      cards: [{
        deviceId: 'heater-1',
        deviceName: 'Bathroom heater',
        kind: 'temperature',
        statusId: 'paused_unmanaged',
        deadlineAtMs: 6_000,
        firstActionAtMs: null,
      }],
      formatTime: () => '06:30',
    });
    expect(hero?.tone).toBe('warn');
    // The paused branch names the ACTUAL recovery, never the unplugged default.
    expect(hero?.subline).toBe('Bathroom heater due 06:30 — not managed by PELS.');
  });
});
