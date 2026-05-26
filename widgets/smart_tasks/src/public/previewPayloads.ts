import type { SmartTasksWidgetReadyPayload } from '../smartTasksWidgetTypes';

export const PREVIEW_SMART_TASKS_PAYLOAD: SmartTasksWidgetReadyPayload = {
  state: 'ready',
  overflowCount: 0,
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
      deviceId: 'preview-ev',
      deviceName: 'EV charger',
      kind: 'ev_soc',
      unitSymbol: '%',
      currentValue: 60,
      targetValue: 80,
      finishLabel: '02:45',
      statusLabel: 'On track',
      tone: 'ok',
    },
  ],
};
