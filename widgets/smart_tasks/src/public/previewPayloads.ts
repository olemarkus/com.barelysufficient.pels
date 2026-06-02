import type { SmartTasksWidgetReadyPayload } from '../smartTasksWidgetTypes';

// Fixed base for the preview chart windows. Absolute values are arbitrary — the
// renderer maps each series' [windowStart, windowEnd] onto the plot regardless
// of wall-clock, so a stable base keeps the preview deterministic.
const T = 1_700_000_000_000;
const H = 60 * 60 * 1000;

export const PREVIEW_SMART_TASKS_PAYLOAD: SmartTasksWidgetReadyPayload = {
  state: 'ready',
  // Non-zero so the preview also demonstrates the "+N in Smart tasks"
  // overflow line below the rows.
  overflowCount: 1,
  rows: [
    {
      deviceId: 'preview-dryer',
      deviceName: 'Dryer',
      kind: 'temperature',
      unitSymbol: '°C',
      currentValue: 38,
      targetValue: 55,
      finishLabel: '04:30',
      statusLabel: 'Cannot finish',
      tone: 'danger',
      etaVerb: 'Due',
      targetActionVerb: 'Heat to',
      targetNoun: 'Target',
      deadlineLongLabel: 'Tomorrow 04:30',
      // Plan-meta is intentionally suppressed on a failing (cannot_meet) task so
      // the recourse line stays above the fold in the 220 px detail panel.
      planMetaLabel: null,
      confidenceLabel: null,
      whyLabel: 'Today’s daily budget runs out before the deadline.',
      recourseHint: 'Budget settings show whether future days need power reserved earlier.',
      chart: null,
    },
    {
      deviceId: 'preview-hot-water',
      deviceName: 'Hot water',
      kind: 'temperature',
      unitSymbol: '°C',
      currentValue: 42,
      targetValue: 55,
      finishLabel: '05:30',
      statusLabel: 'At risk',
      tone: 'warn',
      etaVerb: 'Ready by',
      targetActionVerb: 'Heat to',
      targetNoun: 'Target',
      deadlineLongLabel: 'Tomorrow 05:30',
      planMetaLabel: 'Estimate ≈2h 15m · 1.8 kW · ≈4.0 kWh',
      confidenceLabel: null,
      whyLabel: 'Limited time left before the deadline.',
      recourseHint: null,
      // Planned line climbs steadily to the target by the deadline; the observed
      // line tracks BELOW it and flatter — visibly behind schedule, which is the
      // "at risk" reading made visual (and consistent with the estimate above).
      chart: {
        mode: 'trajectory',
        unit: '°C',
        windowStartMs: T,
        windowEndMs: T + 3 * H,
        plannedOriginal: [
          { atMs: T, value: 42 },
          { atMs: T + H, value: 46.5 },
          { atMs: T + 2 * H, value: 51 },
          { atMs: T + 3 * H, value: 55 },
        ],
        plannedFinal: null,
        observed: [
          { atMs: T, value: 42 },
          { atMs: T + H, value: 44 },
          { atMs: T + 1.5 * H, value: 45.5 },
        ],
        target: 55,
        metAtMs: null,
        metMarkerValue: null,
      },
    },
    {
      // Demonstrates the "Target X" rendering when the device snapshot hasn't
      // reported a current reading yet — the status chip carries the "why"
      // (Building plan…) and the row no longer reads as "— → 22 °C".
      deviceId: 'preview-bedroom',
      deviceName: 'Bedroom heat',
      kind: 'temperature',
      unitSymbol: '°C',
      currentValue: null,
      targetValue: 22,
      finishLabel: '07:00',
      statusLabel: 'Building plan…',
      tone: 'muted',
      etaVerb: 'Ready by',
      targetActionVerb: 'Heat to',
      targetNoun: 'Target',
      deadlineLongLabel: 'Tomorrow 07:00',
      planMetaLabel: null,
      // Confidence chip suppressed while waiting on prices (would conflict with
      // the "Waiting for tomorrow's prices" reason).
      confidenceLabel: null,
      whyLabel: 'Waiting for tomorrow’s prices.',
      recourseHint: null,
      chart: null,
    },
  ],
  endedRows: [
    {
      id: 'preview-ev-ended',
      deviceId: 'preview-ev',
      deviceName: 'EV charger',
      unitSymbol: '%',
      targetValue: 80,
      targetActionVerb: 'Charge to',
      outcomeLabel: 'Succeeded',
      outcomeTone: 'ok',
      finishedLabel: 'Today 06:30',
      progressLabel: '45 → 80 %  ·  target 80 %',
      reachedAtLabel: 'reached at 06:00',
      whyLabel: null,
      recourseHint: null,
      chart: {
        mode: 'trajectory',
        unit: '%',
        windowStartMs: T,
        windowEndMs: T + 4 * H,
        plannedOriginal: [
          { atMs: T, value: 45 },
          { atMs: T + H, value: 45 },
          { atMs: T + 2 * H, value: 60 },
          { atMs: T + 3 * H, value: 73 },
          { atMs: T + 4 * H, value: 80 },
        ],
        plannedFinal: null,
        observed: [
          { atMs: T, value: 45 },
          { atMs: T + H, value: 46 },
          { atMs: T + 2 * H, value: 61 },
          { atMs: T + 3 * H, value: 74 },
          { atMs: T + 3.5 * H, value: 80 },
        ],
        target: 80,
        metAtMs: T + 3.5 * H,
        metMarkerValue: 80,
      },
    },
    {
      id: 'preview-hot-water-past-ended',
      deviceId: 'preview-hot-water-past',
      deviceName: 'Hot water',
      unitSymbol: '°C',
      targetValue: 60,
      targetActionVerb: 'Heat to',
      outcomeLabel: 'Missed',
      outcomeTone: 'warn',
      finishedLabel: 'Mon 23:00',
      progressLabel: '40 → 52 °C  ·  target 60 °C',
      reachedAtLabel: null,
      whyLabel: 'Daily budget filled before the deadline.',
      recourseHint: 'Budget settings show whether future days need power reserved earlier.',
      chart: {
        mode: 'trajectory',
        unit: '°C',
        windowStartMs: T,
        windowEndMs: T + 3 * H,
        plannedOriginal: [
          { atMs: T, value: 40 },
          { atMs: T + H, value: 47 },
          { atMs: T + 2 * H, value: 54 },
          { atMs: T + 3 * H, value: 60 },
        ],
        plannedFinal: null,
        observed: [
          { atMs: T, value: 40 },
          { atMs: T + H, value: 44 },
          { atMs: T + 2 * H, value: 48 },
          { atMs: T + 3 * H, value: 52 },
        ],
        target: 60,
        metAtMs: null,
        metMarkerValue: null,
      },
    },
  ],
};
