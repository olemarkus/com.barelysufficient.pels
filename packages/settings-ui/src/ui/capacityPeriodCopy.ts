import type { CapacityPeriodMinutes } from '../../../contracts/src/capacitySettings.ts';

/** How the hero and its tooltips name the capacity period in running text. */
export const capacityPeriodNoun = (periodMinutes: CapacityPeriodMinutes): 'quarter' | 'hour' => (
  periodMinutes === 15 ? 'quarter' : 'hour'
);
