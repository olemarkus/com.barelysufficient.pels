/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  formatSmartTaskGoalValue,
  formatSmartTaskNowValueLine,
  formatSmartTaskUnknownNowValueLine,
  formatSmartTaskGoalContextLine,
  pluralHour,
  CREATE_SMART_TASK_WIDGET_COPY,
} from '../../packages/shared-domain/src/deadlineLabels';
import {
  formatScheduledHoursWindow,
  formatSmartTaskScheduledLine,
  formatCheapestHoursSubtext,
} from '../../packages/shared-domain/src/smartTaskDeadlineFormat';

// All clock-hour assertions use UTC timestamps + a UTC timezone so the rendered
// "HH:MM" is deterministic regardless of the host zone.
const UTC = 'UTC';
const HOUR_MS = 60 * 60 * 1000;
const at = (hour: number): number => Date.UTC(2026, 0, 1, hour, 0, 0);

describe('pluralHour', () => {
  it('uses the singular only for exactly one', () => {
    expect(pluralHour(1)).toBe('hour');
    expect(pluralHour(0)).toBe('hours');
    expect(pluralHour(2)).toBe('hours');
  });
});

describe('formatSmartTaskGoalValue', () => {
  it('renders percent with no space and temperature with a space', () => {
    expect(formatSmartTaskGoalValue(80, '%')).toBe('80%');
    expect(formatSmartTaskGoalValue(65, '°C')).toBe('65 °C');
  });

  it('keeps one decimal only when it is significant', () => {
    expect(formatSmartTaskGoalValue(64.5, '°C')).toBe('64.5 °C');
    expect(formatSmartTaskGoalValue(64.04, '°C')).toBe('64 °C');
  });
});

describe('formatSmartTaskNowValueLine', () => {
  it('renders "Now <value>" with the shared spacing rules', () => {
    expect(formatSmartTaskNowValueLine({ currentValue: 42, unitSymbol: '%' })).toBe('Now 42%');
    expect(formatSmartTaskNowValueLine({ currentValue: 48, unitSymbol: '°C' })).toBe('Now 48 °C');
  });

  it('returns null when there is no reading', () => {
    expect(formatSmartTaskNowValueLine({ currentValue: null, unitSymbol: '%' })).toBeNull();
    expect(formatSmartTaskNowValueLine({ currentValue: Number.NaN, unitSymbol: '°C' })).toBeNull();
  });
});

describe('formatSmartTaskUnknownNowValueLine', () => {
  it('uses explicit unknown copy instead of a bare unit', () => {
    expect(formatSmartTaskUnknownNowValueLine('ev_soc')).toBe('Charge level unknown');
    expect(formatSmartTaskUnknownNowValueLine('temperature')).toBe('Temperature unknown');
  });
});

describe('formatSmartTaskGoalContextLine', () => {
  it('renders an arrow when the goal is above the current reading', () => {
    expect(formatSmartTaskGoalContextLine({ goalValue: 80, currentValue: 42, unitSymbol: '%' }))
      .toBe('from 42% → 80%');
  });

  it('renders the "Goal … · now …" form when the goal is at or below the reading', () => {
    expect(formatSmartTaskGoalContextLine({ goalValue: 60, currentValue: 65, unitSymbol: '°C' }))
      .toBe('Goal 60 °C · now 65 °C');
  });

  it('collapses to "Goal <value>" when goal and reading render equal', () => {
    expect(formatSmartTaskGoalContextLine({ goalValue: 65, currentValue: 65, unitSymbol: '°C' }))
      .toBe('Goal 65 °C');
  });

  it('collapses to "Goal <value>" when there is no current reading', () => {
    expect(formatSmartTaskGoalContextLine({ goalValue: 80, currentValue: null, unitSymbol: '%' }))
      .toBe('Goal 80%');
  });
});

describe('formatScheduledHoursWindow', () => {
  it('returns null for no scheduled hours', () => {
    expect(formatScheduledHoursWindow([], UTC)).toBeNull();
  });

  it('renders a single hour as its start time', () => {
    expect(formatScheduledHoursWindow([{ startsAtMs: at(2) }], UTC)).toBe('02:00');
  });

  it('renders a contiguous block as a start–end range (last start + 1h)', () => {
    const hours = [{ startsAtMs: at(2) }, { startsAtMs: at(3) }, { startsAtMs: at(4) }];
    // Three contiguous hours 02:00,03:00,04:00 → window 02:00–05:00.
    expect(formatScheduledHoursWindow(hours, UTC)).toBe('02:00–05:00');
  });

  it('renders non-contiguous hours as a comma-separated start list', () => {
    const hours = [{ startsAtMs: at(2) }, { startsAtMs: at(3) }, { startsAtMs: at(14) }];
    expect(formatScheduledHoursWindow(hours, UTC)).toBe('02:00, 03:00, 14:00');
  });

  it('treats a two-hour contiguous pair as a range', () => {
    const hours = [{ startsAtMs: at(2) }, { startsAtMs: at(2) + HOUR_MS }];
    expect(formatScheduledHoursWindow(hours, UTC)).toBe('02:00–04:00');
  });
});

describe('formatSmartTaskScheduledLine', () => {
  const labels = {
    scheduledLabel: CREATE_SMART_TASK_WIDGET_COPY.scheduledLabel,
    readyByLabel: CREATE_SMART_TASK_WIDGET_COPY.readyByLabel,
  };

  it('pairs the window with the resolved ready-by', () => {
    const line = formatSmartTaskScheduledLine({
      scheduledHours: [{ startsAtMs: at(2) }, { startsAtMs: at(3) }],
      deadlineLabel: 'Tomorrow 07:00',
      timeZone: UTC,
      ...labels,
    });
    expect(line).toBe('Scheduled 02:00–04:00 · Ready by Tomorrow 07:00');
  });

  it('collapses to just the ready-by when no hours are scheduled', () => {
    const line = formatSmartTaskScheduledLine({
      scheduledHours: [],
      deadlineLabel: 'Tomorrow 07:00',
      timeZone: UTC,
      ...labels,
    });
    expect(line).toBe('Ready by Tomorrow 07:00');
  });
});

describe('formatCheapestHoursSubtext', () => {
  it('extracts the time half of the deadline label', () => {
    expect(formatCheapestHoursSubtext('Tomorrow 07:00')).toBe('cheapest hours before 07:00');
    expect(formatCheapestHoursSubtext('Today 16:00')).toBe('cheapest hours before 16:00');
  });

  it('falls back to a generic tail when no time is present', () => {
    expect(formatCheapestHoursSubtext('soon')).toBe('cheapest hours before the deadline');
  });
});
