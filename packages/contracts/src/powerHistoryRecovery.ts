/** Main's explicit Insights recovery, published by the power-history owner. */
export type PowerHistoryRecoveryRead =
  | { state: 'idle' }
  | { state: 'running'; requestId: string }
  | { state: 'done'; requestId: string; addedHours: number; firstHour?: string; lastHour?: string }
  | { state: 'failed'; requestId: string; message: string };
