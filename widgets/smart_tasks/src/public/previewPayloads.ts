import type { SmartTasksWidgetReadyPayload } from '../smartTasksWidgetTypes';

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
      recourseHint: 'Lower the daily budget so future days reserve power earlier.',
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
    },
  ],
};
