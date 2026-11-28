import { asUnknownRecord } from '../recordGuards';

export const EV_SMART_TASK_SETTINGS = 'ev_smart_task_settings';

export type EvSmartTaskSettings = {
  usableBatteryKWh?: number;
  pauseOnBatteryDischarge?: true;
};

export const isUsableEvBatteryCapacity = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 5 && value <= 250
);

export const normalizeEvSmartTaskSettings = (value: unknown): Record<string, EvSmartTaskSettings> => (
  Object.fromEntries(Object.entries(asUnknownRecord(value) ?? {}).flatMap(([id, raw]) => {
    const settings = asUnknownRecord(raw);
    const capacity = settings?.usableBatteryKWh;
    const pause = settings?.pauseOnBatteryDischarge === true;
    if (!isUsableEvBatteryCapacity(capacity) && !pause) return [];
    return [[id, {
      ...(isUsableEvBatteryCapacity(capacity) ? { usableBatteryKWh: capacity } : {}),
      ...(pause ? { pauseOnBatteryDischarge: true as const } : {}),
    }]];
  }))
);
