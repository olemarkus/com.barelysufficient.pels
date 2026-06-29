import { ACTIVATION_BACKOFF_MAX_LEVEL } from '../plan/admission';

export const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

export const clampPenaltyLevel = (value: unknown): number => {
  if (!isFiniteNumber(value)) return 0;
  return Math.max(0, Math.min(ACTIVATION_BACKOFF_MAX_LEVEL, Math.trunc(value)));
};
