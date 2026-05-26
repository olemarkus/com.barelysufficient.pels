export type SmartTasksWidgetTone = 'danger' | 'warn' | 'muted' | 'ok';

export type SmartTasksWidgetRow = {
  deviceId: string;
  deviceName: string;
  kind: 'temperature' | 'ev_soc';
  unitSymbol: '°C' | '%';
  currentValue: number | null;
  targetValue: number;
  // Pre-formatted "HH:MM" local-time finish line, or null when no ETA / deadline
  // is available (only happens for some edge pending states).
  finishLabel: string | null;
  statusLabel: string;
  tone: SmartTasksWidgetTone;
};

export type SmartTasksWidgetReadyPayload = {
  state: 'ready';
  rows: SmartTasksWidgetRow[];
  // Number of active (non-satisfied) tasks not included in the top-3.
  overflowCount: number;
};

export type SmartTasksWidgetEmptyPayload = {
  state: 'empty';
  subtitle: string;
};

export type SmartTasksWidgetPayload = SmartTasksWidgetReadyPayload | SmartTasksWidgetEmptyPayload;
