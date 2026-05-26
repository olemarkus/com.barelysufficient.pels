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
    },
  ],
};
