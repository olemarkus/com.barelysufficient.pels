import type { SettingsUiCapacityScalarsRead } from '../../../contracts/src/settingsUiApi.ts';
import { isCapacityPeriodMinutes } from '../../../shared-domain/src/settings/capacityPeriod.ts';

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * Classify the runtime's capacity block at the browser boundary. The producer
 * hands over its own resolved scalars, but they re-enter here over the Homey
 * API bridge, so this adapter validates them once — and anything that is not
 * the resolved shape is `unavailable`, never partly trusted.
 */
export const classifyCapacityScalarsRead = (value: unknown): SettingsUiCapacityScalarsRead => {
  if (!isObject(value) || value.state !== 'resolved' || !isObject(value.scalars)) {
    return { state: 'unavailable' };
  }
  const {
    limitKw, marginKw, periodMinutes, dryRun,
  } = value.scalars;
  if (
    typeof limitKw !== 'number' || !Number.isFinite(limitKw)
    || typeof marginKw !== 'number' || !Number.isFinite(marginKw)
    || !isCapacityPeriodMinutes(periodMinutes)
    || typeof dryRun !== 'boolean'
  ) return { state: 'unavailable' };
  return { state: 'resolved', scalars: { limitKw, marginKw, periodMinutes, dryRun } };
};
