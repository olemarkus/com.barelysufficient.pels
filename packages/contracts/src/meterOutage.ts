/**
 * What the silent-meter pass did when the whole-home meter stopped reporting
 * (`lib/plan/planBuilderSilentMeter.ts`):
 * - `shed`: a power limit relies on the meter, so every managed device was
 *   limited to its floor;
 * - `hold`: no limit relies on it, so the devices were left as they are and
 *   only what needs a measurement (solar-surplus loads, home batteries, solar
 *   curtailment) was released.
 *
 * Which limits count is the power owner's answer (`lib/power/meterDependentLimit.ts`).
 */
export type SilentMeterDirective = 'shed' | 'hold';
